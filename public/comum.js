// comum.js — utilitarios compartilhados entre index.html (Contas) e
// gastos.html (Gastos). Nao contem estado nem logica de negocio especifica
// de nenhuma das duas telas — so funcoes puras e helpers de infraestrutura
// (API, formatacao, mascara de moeda, toast, deteccao de mobile).
// Carregado via <script src="comum.js"> ANTES do <script> inline de cada
// pagina, que depende dessas funcoes/constantes.

const API = '/api';
const ANOS = [2026, 2027];
const MESES_NOMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

// ---------- deteccao de mobile ----------
// Sempre por LARGURA DE TELA (media query / matchMedia), nunca por
// navigator.userAgent — e o jeito certo e padrao de fazer isso, nao quebra
// com emulador nem depende de string de navegador.
const BREAKPOINT_MOBILE = 700;

function ehMobile(){
  return window.matchMedia(`(max-width: ${BREAKPOINT_MOBILE}px)`).matches;
}

// chama o callback so quando a tela CRUZA o breakpoint mobile (nao a cada
// pixel de resize) — usado pra re-renderizar a lista trocando tabela/card
// ao vivo se a janela for redimensionada.
function aoCruzarBreakpoint(callback){
  let estavaMobile = ehMobile();
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const agoraMobile = ehMobile();
      if(agoraMobile !== estavaMobile){
        estavaMobile = agoraMobile;
        callback(agoraMobile);
      }
    }, 150);
  });
}

// ---------- formatacao ----------

function fmt(n){
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// formata "YYYY-MM-DD" como "DD/MM" (usado tanto pra vencimento de Contas
// quanto pra data de compra de Gastos — mesma logica, dominio diferente)
function formatarDataCurta(dataIso){
  if(!dataIso) return '-';
  const [, mes, dia] = dataIso.split('-');
  return `${dia}/${mes}`;
}

function hojeIso(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// aceita tanto "150,50" (formato BR) quanto "150.50" (sem virgula, ponto como decimal)
function parseValorBR(val){
  val = String(val).trim();
  if(val.includes(',')){
    return parseFloat(val.replace(/\./g, '').replace(',', '.')) || 0;
  }
  return parseFloat(val) || 0;
}

// mascara de dinheiro: digita como centavos, vai formatando em tempo real (tipo app de banco)
function mascararComoMoeda(input){
  let digitos = input.value.replace(/\D/g, '');
  digitos = digitos.replace(/^0+(?=\d)/, ''); // tira zeros a esquerda sem quebrar "0"
  const centavos = digitos ? parseInt(digitos, 10) : 0;
  input.value = (centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fim = input.value.length;
  input.setSelectionRange(fim, fim);
}

function ativarMascaraMoeda(input){
  input.addEventListener('input', () => mascararComoMoeda(input));
}

// ---------- toast ----------

let toastTimer = null;
function toast(msg, tipo){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (tipo === 'erro' ? ' erro' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 3200);
}

// ---------- API ----------

async function api(path, opts){
  const res = await fetch(API + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  let data;
  try { data = await res.json(); } catch(e) { data = {}; }
  if(!res.ok){
    throw new Error(data.erro || 'Erro na requisição.');
  }
  return data;
}

// ---------- periodo (ano/mes) ----------

function popularSelects(){
  const selAno = document.getElementById('selAno');
  const selMes = document.getElementById('selMes');
  selAno.innerHTML = ANOS.map(a => `<option value="${a}">${a}</option>`).join('');
  selMes.innerHTML = MESES_NOMES.map((nome, i) => `<option value="${i+1}">${nome}</option>`).join('');
}

// Contas e Gastos compartilham o mesmo periodo selecionado (mesmo `meses`
// no banco) — por isso a escolha fica salva aqui, numa chave so, pra
// alternar entre as duas telas nao resetar pro mes mais recente sozinho.
// So muda quando o usuario troca o seletor manualmente, cria um mes novo
// ou exclui o mes que estava selecionado.
const CHAVE_PERIODO = 'periodoSelecionado';

function salvarPeriodoSelecionado(ano, mes){
  localStorage.setItem(CHAVE_PERIODO, JSON.stringify({ ano, mes }));
}

function obterPeriodoSalvo(){
  try{
    const { ano, mes } = JSON.parse(localStorage.getItem(CHAVE_PERIODO));
    if(ANOS.includes(ano) && mes >= 1 && mes <= 12) return { ano, mes };
  } catch(e){ /* nada salvo ainda ou valor invalido */ }
  return null;
}

// ---------- usuario logado / sessao ----------

async function carregarUsuarioLogado(){
  try{
    const info = await api('/auth/eu');
    if(!info.logado){ window.location.href = '/login.html'; return; }
    const nome = (info.pessoa && info.pessoa.nome) ? info.pessoa.nome : info.usuario.usuario;
    document.getElementById('usuarioLogado').innerHTML = `<span class="nome">${escapeHtml(nome)}</span>`;
  } catch(e){ /* se falhar so o nome nao aparece, nao trava o app */ }
}

document.getElementById('btnSair').onclick = async () => {
  try{ await api('/auth/logout', { method:'POST' }); } catch(e){ /* redireciona mesmo assim */ }
  window.location.href = '/login.html';
};

// ---------- ocultar valores ----------
// chave de localStorage diferente por pagina (Contas/Gastos guardam a
// preferencia separada) — por isso cada pagina chama isso passando a sua.

function configurarOcultarValores(chaveStorage){
  function aplicarPreferenciaOcultar(oculto){
    document.querySelector('.wrap').classList.toggle('oculto-valores', oculto);
    document.getElementById('btnOlho').title = oculto ? 'Mostrar valores' : 'Ocultar valores';
  }
  document.getElementById('btnOlho').onclick = () => {
    const oculto = !document.querySelector('.wrap').classList.contains('oculto-valores');
    aplicarPreferenciaOcultar(oculto);
    localStorage.setItem(chaveStorage, oculto ? '1' : '0');
  };
  aplicarPreferenciaOcultar(localStorage.getItem(chaveStorage) === '1');
}
