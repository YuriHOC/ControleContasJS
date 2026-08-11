// Controle de Contas — servidor unico em Node puro (sem Express, sem framework).
//
// Arquitetura:
// - HTTP: modulo nativo 'http'. As rotas sao resolvidas na mao dentro do
//   callback do createServer (ver "const server = http.createServer" mais abaixo).
// - Banco: SQLite via 'node:sqlite' (nativo do Node, sem instalar nada). Um unico
//   arquivo em data/controle.sqlite.
// - Autenticacao: sessao por cookie HttpOnly (tabela `sessoes`), senha com hash
//   scrypt + salt (sem lib externa, so o modulo 'crypto' do proprio Node).
// - Multi-tenant: cada usuario so enxerga os proprios dados. Isso e garantido
//   filtrando TODA query por usuario_id (direto em agrupamentos/meses, e por
//   JOIN com meses no caso de lancamentos). Ver o aviso mais detalhado logo
//   acima da definicao de `exigirUsuario`.
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 5602;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DB_PATH = path.join(DATA_DIR, 'controle.sqlite');

const ANOS_PERMITIDOS = [2026, 2027];
const MESES_NOMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function rotuloMes(ano, mes) {
  return `${MESES_NOMES[mes - 1]} / ${ano}`;
}

// Cria (ou complementa) o schema do banco. Todas as tabelas usam
// "CREATE TABLE IF NOT EXISTS", entao essa funcao roda toda vez que o servidor
// sobe e nao faz nada em bancos que ja estao no formato atual.
//
// Cadeia de posse (quem pertence a quem):
//   usuarios (1) --- (N) agrupamentos     [tem usuario_id direto]
//   usuarios (1) --- (N) meses            [tem usuario_id direto]
//   usuarios (1) --- (N) lancamentos      [tem usuario_id direto, alem de mes_id]
//   usuarios (1) --- (N) categorias_gasto [tem usuario_id direto]
//   usuarios (1) --- (N) gastos           [tem usuario_id direto, alem de mes_id]
//
// "lancamentos" e "gastos" tem usuario_id DIRETO (nao precisa de JOIN com
// meses pra descobrir o dono) — e uma coluna de conveniencia, preenchida no
// INSERT a partir do usuario ja autenticado na rota. meses.usuario_id continua
// sendo a fonte de verdade pra posse do mes em si. Ainda assim, toda rota que
// leia/edite/apague um lancamento ou gasto PRECISA filtrar por usuario_id,
// senao abre brecha pra um usuario mexer no dado de outro (ver os handlers de
// /api/lancamentos/:id e /api/gastos/:id mais abaixo, que fazem exatamente
// isso).
function criarSchemaNovo(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      senha_hash TEXT NOT NULL,
      senha_salt TEXT NOT NULL,
      criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- "agrupamentos" = as categorias (Contas Fixas, Bancos, Cartao X...).
    -- Nome so precisa ser unico DENTRO do mesmo usuario (por isso o UNIQUE
    -- composto), assim dois usuarios podem ter um agrupamento "Bancos" cada.
    CREATE TABLE IF NOT EXISTS agrupamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      nome TEXT NOT NULL COLLATE NOCASE,
      ordem INTEGER NOT NULL DEFAULT 0,
      UNIQUE(usuario_id, nome)
    );

    -- "meses" = um mes de controle (ex: Julho/2026) de um usuario especifico.
    -- Mesma logica: ano+mes so precisa ser unico dentro do mesmo usuario.
    CREATE TABLE IF NOT EXISTS meses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      ano INTEGER NOT NULL,
      mes INTEGER NOT NULL,
      criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(usuario_id, ano, mes)
    );

    -- "lancamentos" = cada conta dentro de um mes (Aluguel, Cartao PicPay...).
    -- "fixo" e por lancamento, nao por cadastro: ao criar um mes novo, o
    -- servidor olha o que estava marcado como fixo=1 no mes anterior e copia
    -- so isso (ver POST /api/meses mais abaixo). Ou seja, "fixo" e um
    -- comportamento de copia, nao uma tabela separada de "contas cadastradas".
    CREATE TABLE IF NOT EXISTS lancamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      mes_id INTEGER NOT NULL,
      agrupamento_id INTEGER NOT NULL,
      descricao TEXT NOT NULL,
      valor REAL NOT NULL DEFAULT 0,
      detalhe TEXT DEFAULT '',
      data_limite TEXT,
      ok INTEGER NOT NULL DEFAULT 0,
      fixo INTEGER NOT NULL DEFAULT 0,
      ordem INTEGER NOT NULL DEFAULT 0
    );

    -- "categorias_gasto" = categorias de Gastos avulsos (Mercado, Cinema,
    -- Besteira...). Espelha "agrupamentos", mas e uma lista separada —
    -- Gastos nao usa os mesmos agrupamentos de Contas.
    CREATE TABLE IF NOT EXISTS categorias_gasto (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      nome TEXT NOT NULL COLLATE NOCASE,
      ordem INTEGER NOT NULL DEFAULT 0,
      UNIQUE(usuario_id, nome)
    );

    -- "gastos" = compra avulsa (mercado, besteira...) dentro de um mes — o
    -- MESMO mes_id usado por Contas, tabela "meses" e compartilhada entre os
    -- dois. Sem "ok" (gasto ja e uma compra consumada, nao ha "pendente") e
    -- sem "fixo" (gasto avulso nao repete todo mes). "nome" e o titulo curto
    -- do gasto (ex: "Compras do dia a dia") e e OBRIGATORIO; "descricao" e
    -- um texto livre OPCIONAL pra detalhar quando precisar (ex: "Frutas,
    -- carne e produtos de limpeza") — a categoria classifica, o nome
    -- identifica, a descricao detalha.
    CREATE TABLE IF NOT EXISTS gastos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      mes_id INTEGER NOT NULL,
      categoria_gasto_id INTEGER NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT DEFAULT '',
      valor REAL NOT NULL DEFAULT 0,
      data_compra TEXT,
      ordem INTEGER NOT NULL DEFAULT 0
    );

    -- "pessoas" = dados de perfil (nome, nascimento...), 1-pra-1 com usuarios.
    -- Separado de "usuarios" pra manter credenciais (senha) isoladas do resto.
    CREATE TABLE IF NOT EXISTS pessoas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL UNIQUE REFERENCES usuarios(id),
      nome TEXT,
      sobrenome TEXT,
      data_nascimento TEXT,
      pais TEXT,
      estado TEXT,
      gasto_bobo TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- "sessoes" = tokens de login ativos (o valor do cookie HttpOnly). Uma
    -- linha por login feito; expira sozinha (ver SESSAO_DURACAO_MS abaixo).
    CREATE TABLE IF NOT EXISTS sessoes (
      token TEXT PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      expira_em TEXT NOT NULL
    );
  `);
}

// ajusta o "dia" de uma data pro mes/ano de destino (ex: vencimento dia 31 de janeiro vira dia 28/29 em fevereiro)
// usado quando uma conta fixa com vencimento e copiada pro mes novo
function ajustarDiaParaMes(dataIso, novoAno, novoMes) {
  if (!dataIso) return null;
  const partes = String(dataIso).split('-');
  if (partes.length !== 3) return null;
  const dia = Number(partes[2]);
  if (!Number.isInteger(dia)) return null;
  const ultimoDiaDoMes = new Date(novoAno, novoMes, 0).getDate();
  const diaAjustado = Math.min(dia, ultimoDiaDoMes);
  return `${novoAno}-${String(novoMes).padStart(2, '0')}-${String(diaAjustado).padStart(2, '0')}`;
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
criarSchemaNovo(db);

// ---------- autenticacao ----------
//
// Login e feito por cookie de sessao (HttpOnly, no-JS-access), nao por token
// no header nem JWT. Fluxo:
//   1. /api/auth/registrar ou /api/auth/login criam uma linha em `sessoes` e
//      mandam o token de volta via header Set-Cookie (definirCookieSessao).
//   2. Toda rota que precisa saber "quem esta logado" chama exigirUsuario(req)
//      (ou usuarioAtual(req), a versao que nao lanca erro se nao tiver ninguem
//      logado) — ela le o cookie da requisicao e confere na tabela `sessoes`.
//   3. /api/auth/logout apaga a linha da sessao e limpa o cookie.
// Senha nunca e guardada em texto puro: usamos scrypt (nativo do 'crypto' do
// Node, sem lib externa) com um salt aleatorio por usuario.

const SESSAO_DURACAO_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const NOME_COOKIE = 'sessao';

function gerarSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashSenha(senha, salt) {
  return crypto.scryptSync(senha, salt, 64).toString('hex');
}

// compara hashes com timingSafeEqual (em vez de === ) pra nao vazar, por
// diferenca de tempo de resposta, quantos caracteres da senha o atacante acertou
function senhaConfere(senha, salt, hashEsperado) {
  const calculado = Buffer.from(hashSenha(senha, salt), 'hex');
  const esperado = Buffer.from(hashEsperado, 'hex');
  if (calculado.length !== esperado.length) return false;
  return crypto.timingSafeEqual(calculado, esperado);
}

function gerarTokenSessao() {
  return crypto.randomBytes(32).toString('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(par => {
    const idx = par.indexOf('=');
    if (idx === -1) return;
    cookies[par.slice(0, idx).trim()] = decodeURIComponent(par.slice(idx + 1).trim());
  });
  return cookies;
}

function definirCookieSessao(res, token) {
  const maxAgeSegundos = Math.floor(SESSAO_DURACAO_MS / 1000);
  res.setHeader('Set-Cookie', `${NOME_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSegundos}; SameSite=Lax`);
}

function limparCookieSessao(res) {
  res.setHeader('Set-Cookie', `${NOME_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function criarSessao(usuarioId) {
  const token = gerarTokenSessao();
  const expiraEm = new Date(Date.now() + SESSAO_DURACAO_MS).toISOString();
  db.prepare('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES (?, ?, ?)').run(token, usuarioId, expiraEm);
  return token;
}

function usuarioAtual(req) {
  const token = parseCookies(req)[NOME_COOKIE];
  if (!token) return null;
  const sessao = db.prepare('SELECT * FROM sessoes WHERE token = ?').get(token);
  if (!sessao) return null;
  if (new Date(sessao.expira_em).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
    return null;
  }
  return db.prepare('SELECT id, usuario, email FROM usuarios WHERE id = ?').get(sessao.usuario_id);
}

function validarEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------- helpers de dados ----------

function totalsFor(itens) {
  const total = itens.reduce((s, i) => s + Number(i.valor), 0);
  const pago = itens.filter(i => i.ok).reduce((s, i) => s + Number(i.valor), 0);
  return { total, pago, pendente: total - pago };
}

function agrupamentoExiste(id, usuarioId) {
  return !!db.prepare('SELECT 1 FROM agrupamentos WHERE id = ? AND usuario_id = ?').get(id, usuarioId);
}

function categoriaGastoExiste(id, usuarioId) {
  return !!db.prepare('SELECT 1 FROM categorias_gasto WHERE id = ? AND usuario_id = ?').get(id, usuarioId);
}

function mesPorId(id, usuarioId) {
  return db.prepare('SELECT * FROM meses WHERE id = ? AND usuario_id = ?').get(id, usuarioId);
}

function mesComItens(mesId, usuarioId) {
  const mes = mesPorId(mesId, usuarioId);
  if (!mes) return null;
  const itens = db.prepare(
    `SELECT l.*, a.nome as agrupamento_nome, a.ordem as agrupamento_ordem
     FROM lancamentos l
     JOIN agrupamentos a ON a.id = l.agrupamento_id
     WHERE l.mes_id = ?
     ORDER BY a.ordem, a.id, l.ordem, l.id`
  ).all(mesId).map(i => ({
    id: i.id,
    agrupamento_id: i.agrupamento_id,
    grupo: i.agrupamento_nome,
    descricao: i.descricao,
    valor: i.valor,
    detalhe: i.detalhe,
    data_limite: i.data_limite,
    ok: !!i.ok,
    fixo: !!i.fixo,
  }));
  return {
    id: mes.id,
    ano: mes.ano,
    mes: mes.mes,
    rotulo: rotuloMes(mes.ano, mes.mes),
    criado_em: mes.criado_em,
    itens,
    totais: totalsFor(itens),
  };
}

// mesmo padrao de mesComItens, mas pra Gastos: junta com categorias_gasto em
// vez de agrupamentos, e nao tem status ok/pendente (so total).
function mesComItensGasto(mesId, usuarioId) {
  const mes = mesPorId(mesId, usuarioId);
  if (!mes) return null;
  const itens = db.prepare(
    `SELECT g.*, c.nome as categoria_nome, c.ordem as categoria_ordem
     FROM gastos g
     JOIN categorias_gasto c ON c.id = g.categoria_gasto_id
     WHERE g.mes_id = ?
     ORDER BY c.ordem, c.id, g.ordem, g.id`
  ).all(mesId).map(i => ({
    id: i.id,
    categoria_gasto_id: i.categoria_gasto_id,
    categoria: i.categoria_nome,
    nome: i.nome,
    descricao: i.descricao,
    valor: i.valor,
    data_compra: i.data_compra,
  }));
  return {
    id: mes.id,
    ano: mes.ano,
    mes: mes.mes,
    rotulo: rotuloMes(mes.ano, mes.mes),
    criado_em: mes.criado_em,
    itens,
    total: itens.reduce((s, i) => s + Number(i.valor), 0),
  };
}

function listaMeses(usuarioId) {
  const meses = db.prepare('SELECT id, ano, mes, criado_em FROM meses WHERE usuario_id = ? ORDER BY ano DESC, mes DESC').all(usuarioId);
  return meses.map(m => {
    const itens = db.prepare('SELECT valor, ok FROM lancamentos WHERE mes_id = ?').all(m.id);
    return { id: m.id, ano: m.ano, mes: m.mes, rotulo: rotuloMes(m.ano, m.mes), criado_em: m.criado_em, totais: totalsFor(itens) };
  });
}

// mes existente mais recente, cronologicamente anterior a (ano, mes) — usado como referencia
// para copiar as contas fixas na criacao de um mes novo
function mesReferenciaAnterior(ano, mes, usuarioId) {
  const alvo = ano * 12 + mes;
  const todos = db.prepare('SELECT * FROM meses WHERE usuario_id = ?').all(usuarioId);
  let melhor = null;
  let melhorChave = -Infinity;
  for (const m of todos) {
    const chave = m.ano * 12 + m.mes;
    if (chave < alvo && chave > melhorChave) { melhor = m; melhorChave = chave; }
  }
  return melhor;
}

function proximoAnoMesSugerido(usuarioId) {
  const todos = db.prepare('SELECT ano, mes FROM meses WHERE usuario_id = ?').all(usuarioId);
  if (todos.length === 0) {
    const hoje = new Date();
    return { ano: hoje.getFullYear(), mes: hoje.getMonth() + 1 };
  }
  let melhor = todos[0];
  for (const m of todos) if (m.ano * 12 + m.mes > melhor.ano * 12 + melhor.mes) melhor = m;
  let mes = melhor.mes + 1;
  let ano = melhor.ano;
  if (mes > 12) { mes = 1; ano += 1; }
  return { ano, mes };
}

// ---------- API ----------

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 1e6) { reject(new HttpError(413, 'corpo da requisicao muito grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new HttpError(400, 'JSON invalido no corpo da requisicao')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  // path.normalize resolve "..", entao um pedido tipo /../../server.js vira um
  // caminho fora de PUBLIC_DIR e cai nesse if — sem isso, daria pra ler
  // qualquer arquivo do disco so escrevendo ../ na URL.
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function validarInteiro(valor, nome) {
  const n = Number(valor);
  if (!Number.isInteger(n)) throw new HttpError(400, `${nome} invalido`);
  return n;
}

function validarAnoMes(ano, mes) {
  const a = validarInteiro(ano, 'ano');
  const m = validarInteiro(mes, 'mes');
  if (!ANOS_PERMITIDOS.includes(a)) throw new HttpError(400, `ano deve ser um de: ${ANOS_PERMITIDOS.join(', ')}`);
  if (m < 1 || m > 12) throw new HttpError(400, 'mes deve estar entre 1 e 12');
  return { ano: a, mes: m };
}

// aceita "YYYY-MM-DD" (formato do <input type="date">) ou vazio/null; qualquer outra coisa e erro
function validarDataLimiteOpcional(valor) {
  if (valor === undefined) return undefined;
  if (valor === null || valor === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) throw new HttpError(400, 'data limite invalida');
  const [ano, mes, dia] = valor.split('-').map(Number);
  const data = new Date(ano, mes - 1, dia);
  if (data.getFullYear() !== ano || data.getMonth() !== mes - 1 || data.getDate() !== dia) {
    throw new HttpError(400, 'data limite invalida');
  }
  return valor;
}

function proximaOrdemLancamento(mesId) {
  const r = db.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 as o FROM lancamentos WHERE mes_id = ?').get(mesId);
  return r.o;
}

function resolverAgrupamento(body, usuarioId) {
  if (body.agrupamento_id !== undefined && body.agrupamento_id !== null) {
    const id = validarInteiro(body.agrupamento_id, 'agrupamento_id');
    if (!agrupamentoExiste(id, usuarioId)) throw new HttpError(400, 'agrupamento nao encontrado');
    return id;
  }
  if (body.agrupamento_nome && String(body.agrupamento_nome).trim()) {
    const nome = String(body.agrupamento_nome).trim();
    const existente = db.prepare('SELECT id FROM agrupamentos WHERE usuario_id = ? AND nome = ? COLLATE NOCASE').get(usuarioId, nome);
    if (existente) return existente.id;
    const ordem = db.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 as o FROM agrupamentos WHERE usuario_id = ?').get(usuarioId).o;
    const info = db.prepare('INSERT INTO agrupamentos (usuario_id, nome, ordem) VALUES (?, ?, ?)').run(usuarioId, nome, ordem);
    return Number(info.lastInsertRowid);
  }
  throw new HttpError(400, 'informe agrupamento_id ou agrupamento_nome');
}

function proximaOrdemGasto(mesId) {
  const r = db.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 as o FROM gastos WHERE mes_id = ?').get(mesId);
  return r.o;
}

function resolverCategoriaGasto(body, usuarioId) {
  if (body.categoria_gasto_id !== undefined && body.categoria_gasto_id !== null) {
    const id = validarInteiro(body.categoria_gasto_id, 'categoria_gasto_id');
    if (!categoriaGastoExiste(id, usuarioId)) throw new HttpError(400, 'categoria nao encontrada');
    return id;
  }
  if (body.categoria_gasto_nome && String(body.categoria_gasto_nome).trim()) {
    const nome = String(body.categoria_gasto_nome).trim();
    const existente = db.prepare('SELECT id FROM categorias_gasto WHERE usuario_id = ? AND nome = ? COLLATE NOCASE').get(usuarioId, nome);
    if (existente) return existente.id;
    const ordem = db.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 as o FROM categorias_gasto WHERE usuario_id = ?').get(usuarioId).o;
    const info = db.prepare('INSERT INTO categorias_gasto (usuario_id, nome, ordem) VALUES (?, ?, ?)').run(usuarioId, nome, ordem);
    return Number(info.lastInsertRowid);
  }
  throw new HttpError(400, 'informe categoria_gasto_id ou categoria_gasto_nome');
}

// Gate de autenticacao usado no topo de quase toda rota de dados (agrupamentos,
// meses, lancamentos). Lanca 401 se ninguem estiver logado; se estiver, devolve
// o usuario e o `usuario.id` e usado pra filtrar TODAS as queries dali pra
// frente. Esquecer de chamar isso (ou esquecer de usar o usuario.id na query)
// e exatamente o tipo de falha que deixaria um usuario ver dado de outro.
function exigirUsuario(req) {
  const usuario = usuarioAtual(req);
  if (!usuario) throw new HttpError(401, 'não autenticado — faça login novamente');
  return usuario;
}

// Roteador manual: sem Express, sem tabela de rotas — cada bloco abaixo checa
// o path (`p`) e o metodo (`req.method`) e retorna cedo (`return sendJSON(...)`)
// se bater. `m` guarda o resultado do ultimo `p.match(/regex/)` usado pra
// capturar :id nas rotas tipo /api/lancamentos/123.
//
// Padrao repetido em quase toda rota autenticada: buscar o registro JA
// filtrando por usuario_id (ou via JOIN com meses, no caso de lancamentos) e,
// se nao achar, responder 404 "nao encontrado" — mesmo quando o registro
// existe mas e de outro usuario. Isso e proposital: 404 nao entrega pra quem
// esta tentando adivinhar IDs se aquele numero pertence a alguem ou nao existe
// (ver a conversa sobre isso — o termo tecnico e "IDOR").
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  let m; // reaproveitado a cada p.match(...) pra capturar o :id da rota

  try {
    // ---------- autenticacao ----------

    if (p === '/api/auth/verificar-disponibilidade' && req.method === 'POST') {
      const body = await readBody(req);
      const usuario = body.usuario ? String(body.usuario).trim() : '';
      const email = body.email ? String(body.email).trim() : '';
      const usuarioDisponivel = usuario ? !db.prepare('SELECT 1 FROM usuarios WHERE usuario = ? COLLATE NOCASE').get(usuario) : true;
      const emailDisponivel = email ? !db.prepare('SELECT 1 FROM usuarios WHERE email = ? COLLATE NOCASE').get(email) : true;
      return sendJSON(res, 200, { usuarioDisponivel, emailDisponivel });
    }

    if (p === '/api/auth/registrar' && req.method === 'POST') {
      const body = await readBody(req);
      const usuario = String(body.usuario || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const senha = String(body.senha || '');
      const confirmacaoSenha = String(body.confirmacaoSenha || '');

      if (usuario.length < 3) throw new HttpError(400, 'o usuário precisa ter pelo menos 3 caracteres');
      if (!/^[a-zA-Z0-9_.]+$/.test(usuario)) throw new HttpError(400, 'o usuário deve conter apenas letras, números, ponto ou underline');
      if (!validarEmail(email)) throw new HttpError(400, 'e-mail inválido');
      if (senha.length < 6) throw new HttpError(400, 'a senha precisa ter pelo menos 6 caracteres');
      if (senha !== confirmacaoSenha) throw new HttpError(400, 'as senhas não coincidem');
      if (db.prepare('SELECT 1 FROM usuarios WHERE usuario = ? COLLATE NOCASE').get(usuario)) throw new HttpError(409, 'esse usuário já existe');
      if (db.prepare('SELECT 1 FROM usuarios WHERE email = ? COLLATE NOCASE').get(email)) throw new HttpError(409, 'esse e-mail já está cadastrado');

      const salt = gerarSalt();
      const hash = hashSenha(senha, salt);
      const infoUsuario = db.prepare(
        'INSERT INTO usuarios (usuario, email, senha_hash, senha_salt) VALUES (?, ?, ?, ?)'
      ).run(usuario, email, hash, salt);
      const usuarioId = Number(infoUsuario.lastInsertRowid);

      const campoTexto = (v) => (v && String(v).trim()) ? String(v).trim() : null;
      db.prepare(
        `INSERT INTO pessoas (usuario_id, nome, sobrenome, data_nascimento, pais, estado, gasto_bobo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        usuarioId,
        campoTexto(body.nome),
        campoTexto(body.sobrenome),
        campoTexto(body.data_nascimento),
        campoTexto(body.pais),
        campoTexto(body.estado),
        campoTexto(body.gasto_bobo)
      );

      const token = criarSessao(usuarioId);
      definirCookieSessao(res, token);
      return sendJSON(res, 201, { id: usuarioId, usuario, email });
    }

    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const identificador = String(body.usuario || body.email || '').trim();
      const senha = String(body.senha || '');
      if (!identificador || !senha) throw new HttpError(400, 'informe usuário/e-mail e senha');

      const linha = db.prepare(
        'SELECT * FROM usuarios WHERE usuario = ? COLLATE NOCASE OR email = ? COLLATE NOCASE'
      ).get(identificador, identificador);

      if (!linha || !senhaConfere(senha, linha.senha_salt, linha.senha_hash)) {
        throw new HttpError(401, 'usuário/e-mail ou senha incorretos');
      }

      const token = criarSessao(linha.id);
      definirCookieSessao(res, token);
      return sendJSON(res, 200, { id: linha.id, usuario: linha.usuario, email: linha.email });
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      const token = parseCookies(req)[NOME_COOKIE];
      if (token) db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
      limparCookieSessao(res);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/auth/eu' && req.method === 'GET') {
      const usuario = usuarioAtual(req);
      if (!usuario) return sendJSON(res, 200, { logado: false });
      const pessoa = db.prepare(
        'SELECT nome, sobrenome, data_nascimento, pais, estado, gasto_bobo FROM pessoas WHERE usuario_id = ?'
      ).get(usuario.id);
      return sendJSON(res, 200, { logado: true, usuario, pessoa: pessoa || null });
    }

    if (p === '/api/auth/conta' && req.method === 'DELETE') {
      const usuario = usuarioAtual(req);
      if (!usuario) throw new HttpError(401, 'não autenticado');
      db.exec('BEGIN');
      try {
        const idsMeses = db.prepare('SELECT id FROM meses WHERE usuario_id = ?').all(usuario.id).map(m => m.id);
        for (const mesId of idsMeses) {
          db.prepare('DELETE FROM lancamentos WHERE mes_id = ?').run(mesId);
          db.prepare('DELETE FROM gastos WHERE mes_id = ?').run(mesId);
        }
        db.prepare('DELETE FROM meses WHERE usuario_id = ?').run(usuario.id);
        db.prepare('DELETE FROM agrupamentos WHERE usuario_id = ?').run(usuario.id);
        db.prepare('DELETE FROM categorias_gasto WHERE usuario_id = ?').run(usuario.id);
        db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(usuario.id);
        db.prepare('DELETE FROM pessoas WHERE usuario_id = ?').run(usuario.id);
        db.prepare('DELETE FROM usuarios WHERE id = ?').run(usuario.id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      limparCookieSessao(res);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- agrupamentos ----------
    if (p === '/api/agrupamentos' && req.method === 'GET') {
      const usuario = exigirUsuario(req);
      const grupos = db.prepare('SELECT * FROM agrupamentos WHERE usuario_id = ? ORDER BY ordem, id').all(usuario.id);
      const resultado = grupos.map(g => ({
        id: g.id,
        nome: g.nome,
        ordem: g.ordem,
        emUso: db.prepare('SELECT 1 FROM lancamentos WHERE agrupamento_id = ? LIMIT 1').get(g.id) ? true : false,
      }));
      return sendJSON(res, 200, resultado);
    }

    if (p === '/api/agrupamentos' && req.method === 'POST') {
      const usuario = exigirUsuario(req);
      const body = await readBody(req);
      const nome = String(body.nome || '').trim();
      if (!nome) throw new HttpError(400, 'informe um nome para o agrupamento');
      if (db.prepare('SELECT 1 FROM agrupamentos WHERE usuario_id = ? AND nome = ? COLLATE NOCASE').get(usuario.id, nome)) {
        throw new HttpError(409, `ja existe um agrupamento chamado "${nome}"`);
      }
      const ordem = db.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 as o FROM agrupamentos WHERE usuario_id = ?').get(usuario.id).o;
      const info = db.prepare('INSERT INTO agrupamentos (usuario_id, nome, ordem) VALUES (?, ?, ?)').run(usuario.id, nome, ordem);
      return sendJSON(res, 201, { id: Number(info.lastInsertRowid), nome, ordem, emUso: false });
    }

    m = p.match(/^\/api\/agrupamentos\/(\d+)$/);
    if (m && req.method === 'PATCH') {
      const usuario = exigirUsuario(req);
      const id = Number(m[1]);
      if (!agrupamentoExiste(id, usuario.id)) throw new HttpError(404, 'agrupamento nao encontrado');
      const body = await readBody(req);
      const nome = String(body.nome || '').trim();
      if (!nome) throw new HttpError(400, 'informe um nome para o agrupamento');
      const conflito = db.prepare('SELECT id FROM agrupamentos WHERE usuario_id = ? AND nome = ? COLLATE NOCASE AND id != ?').get(usuario.id, nome, id);
      if (conflito) throw new HttpError(409, `ja existe um agrupamento chamado "${nome}"`);
      db.prepare('UPDATE agrupamentos SET nome = ? WHERE id = ?').run(nome, id);
      return sendJSON(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/agrupamentos\/(\d+)\/mover$/);
    if (m && req.method === 'PATCH') {
      const usuario = exigirUsuario(req);
      const id = Number(m[1]);
      const body = await readBody(req);
      const direcao = body.direcao;
      if (direcao !== 'up' && direcao !== 'down') throw new HttpError(400, 'direcao deve ser "up" ou "down"');
      const grupos = db.prepare('SELECT * FROM agrupamentos WHERE usuario_id = ? ORDER BY ordem, id').all(usuario.id);
      const idx = grupos.findIndex(g => g.id === id);
      if (idx === -1) throw new HttpError(404, 'agrupamento nao encontrado');
      const alvoIdx = direcao === 'up' ? idx - 1 : idx + 1;
      if (alvoIdx < 0 || alvoIdx >= grupos.length) return sendJSON(res, 200, { ok: true });
      const a = grupos[idx], b = grupos[alvoIdx];
      db.prepare('UPDATE agrupamentos SET ordem = ? WHERE id = ?').run(b.ordem, a.id);
      db.prepare('UPDATE agrupamentos SET ordem = ? WHERE id = ?').run(a.ordem, b.id);
      return sendJSON(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/agrupamentos\/(\d+)$/);
    if (m && req.method === 'DELETE') {
      const usuario = exigirUsuario(req);
      const id = Number(m[1]);
      if (!agrupamentoExiste(id, usuario.id)) throw new HttpError(404, 'agrupamento nao encontrado');
      const emUso = db.prepare('SELECT COUNT(*) as n FROM lancamentos WHERE agrupamento_id = ?').get(id).n;
      if (emUso > 0) {
        throw new HttpError(409, `este agrupamento tem ${emUso} lancamento(s) no historico e nao pode ser excluido — renomeie em vez disso, ou remova os lancamentos primeiro`);
      }
      db.prepare('DELETE FROM agrupamentos WHERE id = ?').run(id);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- categorias_gasto ----------
    if (p === '/api/categorias-gasto' && req.method === 'GET') {
      const usuario = exigirUsuario(req);
      const categorias = db.prepare('SELECT * FROM categorias_gasto WHERE usuario_id = ? ORDER BY ordem, id').all(usuario.id);
      const resultado = categorias.map(c => ({
        id: c.id,
        nome: c.nome,
        ordem: c.ordem,
        emUso: db.prepare('SELECT 1 FROM gastos WHERE categoria_gasto_id = ? LIMIT 1').get(c.id) ? true : false,
      }));
      return sendJSON(res, 200, resultado);
    }

    if (p === '/api/categorias-gasto' && req.method === 'POST') {
      const usuario = exigirUsuario(req);
      const body = await readBody(req);
      const nome = String(body.nome || '').trim();
      if (!nome) throw new HttpError(400, 'informe um nome para a categoria');
      if (db.prepare('SELECT 1 FROM categorias_gasto WHERE usuario_id = ? AND nome = ? COLLATE NOCASE').get(usuario.id, nome)) {
        throw new HttpError(409, `ja existe uma categoria chamada "${nome}"`);
      }
      const ordem = db.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 as o FROM categorias_gasto WHERE usuario_id = ?').get(usuario.id).o;
      const info = db.prepare('INSERT INTO categorias_gasto (usuario_id, nome, ordem) VALUES (?, ?, ?)').run(usuario.id, nome, ordem);
      return sendJSON(res, 201, { id: Number(info.lastInsertRowid), nome, ordem, emUso: false });
    }

    m = p.match(/^\/api\/categorias-gasto\/(\d+)$/);
    if (m && req.method === 'PATCH') {
      const usuario = exigirUsuario(req);
      const id = Number(m[1]);
      if (!categoriaGastoExiste(id, usuario.id)) throw new HttpError(404, 'categoria nao encontrada');
      const body = await readBody(req);
      const nome = String(body.nome || '').trim();
      if (!nome) throw new HttpError(400, 'informe um nome para a categoria');
      const conflito = db.prepare('SELECT id FROM categorias_gasto WHERE usuario_id = ? AND nome = ? COLLATE NOCASE AND id != ?').get(usuario.id, nome, id);
      if (conflito) throw new HttpError(409, `ja existe uma categoria chamada "${nome}"`);
      db.prepare('UPDATE categorias_gasto SET nome = ? WHERE id = ?').run(nome, id);
      return sendJSON(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/categorias-gasto\/(\d+)\/mover$/);
    if (m && req.method === 'PATCH') {
      const usuario = exigirUsuario(req);
      const id = Number(m[1]);
      const body = await readBody(req);
      const direcao = body.direcao;
      if (direcao !== 'up' && direcao !== 'down') throw new HttpError(400, 'direcao deve ser "up" ou "down"');
      const categorias = db.prepare('SELECT * FROM categorias_gasto WHERE usuario_id = ? ORDER BY ordem, id').all(usuario.id);
      const idx = categorias.findIndex(c => c.id === id);
      if (idx === -1) throw new HttpError(404, 'categoria nao encontrada');
      const alvoIdx = direcao === 'up' ? idx - 1 : idx + 1;
      if (alvoIdx < 0 || alvoIdx >= categorias.length) return sendJSON(res, 200, { ok: true });
      const a = categorias[idx], b = categorias[alvoIdx];
      db.prepare('UPDATE categorias_gasto SET ordem = ? WHERE id = ?').run(b.ordem, a.id);
      db.prepare('UPDATE categorias_gasto SET ordem = ? WHERE id = ?').run(a.ordem, b.id);
      return sendJSON(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/categorias-gasto\/(\d+)$/);
    if (m && req.method === 'DELETE') {
      const usuario = exigirUsuario(req);
      const id = Number(m[1]);
      if (!categoriaGastoExiste(id, usuario.id)) throw new HttpError(404, 'categoria nao encontrada');
      const emUso = db.prepare('SELECT COUNT(*) as n FROM gastos WHERE categoria_gasto_id = ?').get(id).n;
      if (emUso > 0) {
        throw new HttpError(409, `esta categoria tem ${emUso} gasto(s) no historico e nao pode ser excluida — renomeie em vez disso, ou remova os gastos primeiro`);
      }
      db.prepare('DELETE FROM categorias_gasto WHERE id = ?').run(id);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- meses ----------
    if (p === '/api/meses' && req.method === 'GET') {
      const usuario = exigirUsuario(req);
      return sendJSON(res, 200, listaMeses(usuario.id));
    }

    if (p === '/api/meses/sugestao' && req.method === 'GET') {
      const usuario = exigirUsuario(req);
      return sendJSON(res, 200, proximoAnoMesSugerido(usuario.id));
    }

    if (p === '/api/meses/buscar' && req.method === 'GET') {
      const usuario = exigirUsuario(req);
      const ano = Number(u.searchParams.get('ano'));
      const mes = Number(u.searchParams.get('mes'));
      if (!ano || !mes) throw new HttpError(400, 'informe ano e mes');
      const linha = db.prepare('SELECT id FROM meses WHERE usuario_id = ? AND ano = ? AND mes = ?').get(usuario.id, ano, mes);
      if (!linha) return sendJSON(res, 200, { existe: false });
      return sendJSON(res, 200, { existe: true, mes: mesComItens(linha.id, usuario.id) });
    }

    if (p === '/api/meses' && req.method === 'POST') {
      const usuario = exigirUsuario(req);
      const body = await readBody(req);
      const { ano, mes } = validarAnoMes(body.ano, body.mes);
      if (db.prepare('SELECT 1 FROM meses WHERE usuario_id = ? AND ano = ? AND mes = ?').get(usuario.id, ano, mes)) {
        throw new HttpError(409, `${rotuloMes(ano, mes)} ja existe`);
      }

      const info = db.prepare('INSERT INTO meses (usuario_id, ano, mes) VALUES (?, ?, ?)').run(usuario.id, ano, mes);
      const mesId = Number(info.lastInsertRowid);

      const referencia = mesReferenciaAnterior(ano, mes, usuario.id);
      if (referencia) {
        const fixos = db.prepare(
          `SELECT l.*, a.ordem as agrupamento_ordem FROM lancamentos l
           JOIN agrupamentos a ON a.id = l.agrupamento_id
           WHERE l.mes_id = ? AND l.fixo = 1
           ORDER BY a.ordem, a.id, l.ordem, l.id`
        ).all(referencia.id);
        const insertLanc = db.prepare(
          'INSERT INTO lancamentos (usuario_id, mes_id, agrupamento_id, descricao, valor, detalhe, data_limite, ok, fixo, ordem) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)'
        );
        fixos.forEach((l, i) => insertLanc.run(
          usuario.id, mesId, l.agrupamento_id, l.descricao, l.valor, l.detalhe, ajustarDiaParaMes(l.data_limite, ano, mes), i
        ));
      }

      return sendJSON(res, 201, mesComItens(mesId, usuario.id));
    }

    m = p.match(/^\/api\/meses\/(\d+)$/);
    if (m && req.method === 'GET') {
      const usuario = exigirUsuario(req);
      const mes = mesComItens(Number(m[1]), usuario.id);
      if (!mes) throw new HttpError(404, 'mes nao encontrado');
      return sendJSON(res, 200, mes);
    }

    m = p.match(/^\/api\/meses\/(\d+)$/);
    if (m && req.method === 'DELETE') {
      const usuario = exigirUsuario(req);
      const id = Number(m[1]);
      if (!mesPorId(id, usuario.id)) throw new HttpError(404, 'mes nao encontrado');
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM lancamentos WHERE mes_id = ?').run(id);
        db.prepare('DELETE FROM gastos WHERE mes_id = ?').run(id);
        db.prepare('DELETE FROM meses WHERE id = ?').run(id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- lancamentos ----------
    if (p === '/api/lancamentos' && req.method === 'POST') {
      const usuario = exigirUsuario(req);
      const body = await readBody(req);
      const mesId = validarInteiro(body.mes_id, 'mes_id');
      if (!mesPorId(mesId, usuario.id)) throw new HttpError(400, 'mes nao encontrado');
      const descricao = String(body.descricao || '').trim();
      if (!descricao) throw new HttpError(400, 'informe a descricao');
      const valor = Number(body.valor) || 0;
      const detalhe = body.detalhe ? String(body.detalhe) : '';
      const dataLimite = validarDataLimiteOpcional(body.data_limite) || null;
      const fixo = body.fixo ? 1 : 0;
      const agrupamentoId = resolverAgrupamento(body, usuario.id);

      const ordem = proximaOrdemLancamento(mesId);
      db.prepare(
        'INSERT INTO lancamentos (usuario_id, mes_id, agrupamento_id, descricao, valor, detalhe, data_limite, ok, fixo, ordem) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
      ).run(usuario.id, mesId, agrupamentoId, descricao, valor, detalhe, dataLimite, fixo, ordem);

      return sendJSON(res, 201, mesComItens(mesId, usuario.id));
    }

    m = p.match(/^\/api\/lancamentos\/(\d+)\/fixo$/);
    if (m && req.method === 'PATCH') {
      const usuario = exigirUsuario(req);
      const id = Number(m[1]);
      const lanc = db.prepare('SELECT * FROM lancamentos WHERE id = ? AND usuario_id = ?').get(id, usuario.id);
      if (!lanc) throw new HttpError(404, 'lancamento nao encontrado');
      const body = await readBody(req);
      db.prepare('UPDATE lancamentos SET fixo = ? WHERE id = ?').run(body.fixo ? 1 : 0, id);
      return sendJSON(res, 200, mesComItens(lanc.mes_id, usuario.id));
    }

    m = p.match(/^\/api\/lancamentos\/(\d+)$/);
    if (m && req.method === 'PATCH') {
      const usuario = exigirUsuario(req);
      const id = Number(m[1]);
      const lanc = db.prepare('SELECT * FROM lancamentos WHERE id = ? AND usuario_id = ?').get(id, usuario.id);
      if (!lanc) throw new HttpError(404, 'lancamento nao encontrado');
      const body = await readBody(req);

      const descricao = body.descricao !== undefined ? String(body.descricao).trim() : lanc.descricao;
      if (body.descricao !== undefined && !descricao) throw new HttpError(400, 'descricao nao pode ficar vazia');
      const valor = body.valor !== undefined ? (Number(body.valor) || 0) : lanc.valor;
      const detalhe = body.detalhe !== undefined ? String(body.detalhe) : lanc.detalhe;
      const dataLimiteValidada = validarDataLimiteOpcional(body.data_limite);
      const dataLimite = dataLimiteValidada !== undefined ? dataLimiteValidada : lanc.data_limite;
      const ok = body.ok !== undefined ? (body.ok ? 1 : 0) : lanc.ok;

      db.prepare('UPDATE lancamentos SET descricao = ?, valor = ?, detalhe = ?, data_limite = ?, ok = ? WHERE id = ?')
        .run(descricao, valor, detalhe, dataLimite, ok, id);

      return sendJSON(res, 200, mesComItens(lanc.mes_id, usuario.id));
    }

    m = p.match(/^\/api\/lancamentos\/(\d+)$/);
    if (m && req.method === 'DELETE') {
      const usuario = exigirUsuario(req);
      const id = Number(m[1]);
      const lanc = db.prepare('SELECT * FROM lancamentos WHERE id = ? AND usuario_id = ?').get(id, usuario.id);
      if (!lanc) throw new HttpError(404, 'lancamento nao encontrado');
      db.prepare('DELETE FROM lancamentos WHERE id = ?').run(id);
      return sendJSON(res, 200, mesComItens(lanc.mes_id, usuario.id));
    }

    // ---------- gastos ----------
    // "buscar" usa a MESMA linha de "meses" que Contas (tabela compartilhada);
    // criacao de mes continua sendo so POST /api/meses.
    if (p === '/api/gastos/buscar' && req.method === 'GET') {
      const usuario = exigirUsuario(req);
      const ano = Number(u.searchParams.get('ano'));
      const mes = Number(u.searchParams.get('mes'));
      if (!ano || !mes) throw new HttpError(400, 'informe ano e mes');
      const linha = db.prepare('SELECT id FROM meses WHERE usuario_id = ? AND ano = ? AND mes = ?').get(usuario.id, ano, mes);
      if (!linha) return sendJSON(res, 200, { existe: false });
      return sendJSON(res, 200, { existe: true, mes: mesComItensGasto(linha.id, usuario.id) });
    }

    if (p === '/api/gastos' && req.method === 'POST') {
      const usuario = exigirUsuario(req);
      const body = await readBody(req);
      const mesId = validarInteiro(body.mes_id, 'mes_id');
      if (!mesPorId(mesId, usuario.id)) throw new HttpError(400, 'mes nao encontrado');
      const nome = String(body.nome || '').trim();
      if (!nome) throw new HttpError(400, 'informe o nome do gasto');
      const descricao = body.descricao ? String(body.descricao).trim() : '';
      const valor = Number(body.valor) || 0;
      const dataCompra = validarDataLimiteOpcional(body.data_compra) || null;
      const categoriaGastoId = resolverCategoriaGasto(body, usuario.id);

      const ordem = proximaOrdemGasto(mesId);
      db.prepare(
        'INSERT INTO gastos (usuario_id, mes_id, categoria_gasto_id, nome, descricao, valor, data_compra, ordem) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(usuario.id, mesId, categoriaGastoId, nome, descricao, valor, dataCompra, ordem);

      return sendJSON(res, 201, mesComItensGasto(mesId, usuario.id));
    }

    m = p.match(/^\/api\/gastos\/(\d+)$/);
    if (m && req.method === 'PATCH') {
      const usuario = exigirUsuario(req);
      const id = Number(m[1]);
      const gasto = db.prepare('SELECT * FROM gastos WHERE id = ? AND usuario_id = ?').get(id, usuario.id);
      if (!gasto) throw new HttpError(404, 'gasto nao encontrado');
      const body = await readBody(req);

      const nome = body.nome !== undefined ? String(body.nome).trim() : gasto.nome;
      if (body.nome !== undefined && !nome) throw new HttpError(400, 'nome nao pode ficar vazio');
      const descricao = body.descricao !== undefined ? String(body.descricao).trim() : gasto.descricao;
      const valor = body.valor !== undefined ? (Number(body.valor) || 0) : gasto.valor;
      const dataCompraValidada = validarDataLimiteOpcional(body.data_compra);
      const dataCompra = dataCompraValidada !== undefined ? dataCompraValidada : gasto.data_compra;

      db.prepare('UPDATE gastos SET nome = ?, descricao = ?, valor = ?, data_compra = ? WHERE id = ?')
        .run(nome, descricao, valor, dataCompra, id);

      return sendJSON(res, 200, mesComItensGasto(gasto.mes_id, usuario.id));
    }

    m = p.match(/^\/api\/gastos\/(\d+)$/);
    if (m && req.method === 'DELETE') {
      const usuario = exigirUsuario(req);
      const id = Number(m[1]);
      const gasto = db.prepare('SELECT * FROM gastos WHERE id = ? AND usuario_id = ?').get(id, usuario.id);
      if (!gasto) throw new HttpError(404, 'gasto nao encontrado');
      db.prepare('DELETE FROM gastos WHERE id = ?').run(id);
      return sendJSON(res, 200, mesComItensGasto(gasto.mes_id, usuario.id));
    }

    // se chegou aqui e o path comecava com /api/, nenhuma rota acima bateu
    if (p.startsWith('/api/')) throw new HttpError(404, 'rota nao encontrada');

    // gate de login nas paginas HTML (isso e o que faz o app abrir direto na
    // tela de login quando ninguem esta autenticado, em vez de mostrar dados):
    // - paginas protegidas (/, /index.html, /gastos.html) sem sessao valida -> manda pro login
    // - paginas de login/cadastro com sessao ja valida -> manda de volta pro app
    //   (evita a pessoa logada cair de novo na tela de criar conta)
    const paginasAuth = ['/login.html', '/cadastro.html'];
    const paginaPrincipal = p === '/' || p === '/index.html' || p === '/gastos.html';

    if (paginaPrincipal || paginasAuth.includes(p)) {
      const logado = !!usuarioAtual(req);
      if (paginaPrincipal && !logado) {
        res.writeHead(302, { Location: '/login.html' });
        return res.end();
      }
      if (paginasAuth.includes(p) && logado) {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
    }

    return serveStatic(req, res, p);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    const status = err.status || 500;
    return sendJSON(res, status, { erro: err.message || 'erro interno' });
  }
});

server.listen(PORT, () => {
  console.log(`Controle de Contas rodando em http://localhost:${PORT}`);
  console.log(`Banco de dados: ${DB_PATH}`);
});
