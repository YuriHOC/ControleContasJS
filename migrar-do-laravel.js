// migrar-do-laravel.js — script avulso e reexecutavel, roda SEPARADO do
// server.js (nunca com o servidor no ar). Traz pro banco deste projeto
// (data/controle.sqlite) os dados novos/alterados que estiverem no banco
// do projeto ControleContasLaravel.
//
// Uso: node migrar-do-laravel.js
//
// O que faz, tabela por tabela (pessoas, agrupamentos, categorias_gasto,
// meses, lancamentos, gastos): compara linha a linha por id entre os dois
// bancos e
//   - insere aqui o que existe no Laravel mas ainda nao existe aqui
//   - atualiza aqui o que existe nos dois mas com valor diferente
//   - nao apaga nada que exista aqui e nao exista mais no Laravel (se voce
//     excluiu algo la, precisa excluir aqui manualmente tambem)
//
// NUNCA mexe na tabela "usuarios": o hash de senha daqui (scrypt) e o de
// la (bcrypt do Laravel) sao formatos incompativeis, entao a senha de
// login sempre continua sendo a deste banco. Se aparecer um usuario novo
// no Laravel que ainda nao exista aqui, a linha dele (e tudo que
// referencia o usuario_id dele) e pulada e avisada no console — pra criar
// esse usuario aqui e preciso passar pelo cadastro normal do app.
//
// Roda tudo numa transacao: se algo der erro no meio, nada e salvo (ROLLBACK).
// Faz backup automatico de controle.sqlite antes de escrever, em data/backups/.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const CAMINHO_NODE = path.join(__dirname, 'data', 'controle.sqlite');
const CAMINHO_LARAVEL = 'C:/Yuri/Projects/ControleContasLaravel/database/database.sqlite';
const PASTA_BACKUPS = path.join(__dirname, 'data', 'backups');

// ordem importa: categorias/agrupamentos/meses antes dos itens que os referenciam
const TABELAS = ['pessoas', 'agrupamentos', 'categorias_gasto', 'meses', 'lancamentos', 'gastos'];

function backupAntesDeEscrever() {
  if (!fs.existsSync(PASTA_BACKUPS)) fs.mkdirSync(PASTA_BACKUPS, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const destino = path.join(PASTA_BACKUPS, `controle.sqlite.antes-migracao-laravel-${ts}.bak`);
  fs.copyFileSync(CAMINHO_NODE, destino);
  console.log('Backup criado em: ' + destino);
}

function nomesDasColunas(db, tabela) {
  return db.prepare(`PRAGMA table_info(${tabela})`).all().map(c => c.name);
}

function linhasIguais(a, b, colunas) {
  return colunas.every(c => String(a[c] ?? '') === String(b[c] ?? ''));
}

function sincronizarTabela(nodeDb, larDb, tabela) {
  const colunas = nomesDasColunas(nodeDb, tabela);
  const existentesNode = new Map(nodeDb.prepare(`SELECT * FROM ${tabela}`).all().map(r => [r.id, r]));
  const linhasLaravel = larDb.prepare(`SELECT * FROM ${tabela}`).all();

  let inseridos = 0, atualizados = 0, pulados = 0;

  for (const linha of linhasLaravel) {
    if (linha.usuario_id !== undefined) {
      const usuarioExiste = nodeDb.prepare('SELECT 1 FROM usuarios WHERE id = ?').get(linha.usuario_id);
      if (!usuarioExiste) {
        console.log(`  [pulado] ${tabela} id=${linha.id}: usuario_id ${linha.usuario_id} nao existe neste banco`);
        pulados++;
        continue;
      }
    }

    const existente = existentesNode.get(linha.id);
    if (!existente) {
      const placeholders = colunas.map(() => '?').join(', ');
      nodeDb.prepare(`INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${placeholders})`)
        .run(...colunas.map(c => linha[c]));
      inseridos++;
    } else if (!linhasIguais(existente, linha, colunas)) {
      const sets = colunas.filter(c => c !== 'id').map(c => `${c} = ?`).join(', ');
      const valores = colunas.filter(c => c !== 'id').map(c => linha[c]);
      nodeDb.prepare(`UPDATE ${tabela} SET ${sets} WHERE id = ?`).run(...valores, linha.id);
      atualizados++;
    }
  }

  console.log(`${tabela}: ${inseridos} inserido(s), ${atualizados} atualizado(s), ${pulados} pulado(s)`);
}

function main() {
  if (!fs.existsSync(CAMINHO_LARAVEL)) {
    console.error('Banco do Laravel nao encontrado em: ' + CAMINHO_LARAVEL);
    process.exit(1);
  }
  if (!fs.existsSync(CAMINHO_NODE)) {
    console.error('Banco deste projeto nao encontrado em: ' + CAMINHO_NODE);
    process.exit(1);
  }

  backupAntesDeEscrever();

  const nodeDb = new DatabaseSync(CAMINHO_NODE);
  const larDb = new DatabaseSync(CAMINHO_LARAVEL, { readOnly: true });
  nodeDb.exec('PRAGMA foreign_keys = ON');

  nodeDb.exec('BEGIN');
  try {
    for (const tabela of TABELAS) sincronizarTabela(nodeDb, larDb, tabela);
    nodeDb.exec('COMMIT');
    console.log('Migracao concluida com sucesso.');
  } catch (e) {
    nodeDb.exec('ROLLBACK');
    console.error('Erro durante a migracao, nada foi salvo:', e);
    process.exit(1);
  } finally {
    nodeDb.close();
    larDb.close();
  }
}

main();
