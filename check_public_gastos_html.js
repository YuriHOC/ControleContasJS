
let categorias = [];
let mesAtual = null;   // mes carregado (com itens de gasto) ou null se nao existe ainda
let anoSelecionado = null;
let mesSelecionado = null;
let selecionados = new Set(); // ids de gastos marcados pra somar, so no mes atual
let editandoId = null; // id do gasto em edicao no momento (so um por vez), ou null

async function iniciar(){
  popularSelects();
  await carregarUsuarioLogado();
  await carregarCategorias();

  const lista = await api('/meses');
  let alvoAno, alvoMes;
  if(lista.length > 0){
    alvoAno = lista[0].ano;
    alvoMes = lista[0].mes;
  } else {
    const sugestao = await api('/meses/sugestao');
    alvoAno = sugestao.ano;
    alvoMes = sugestao.mes;
  }

  document.getElementById('selAno').value = alvoAno;
  document.getElementById('selMes').value = alvoMes;
  anoSelecionado = alvoAno;
  mesSelecionado = alvoMes;

  await selecionarPeriodo();

  document.getElementById('selAno').addEventListener('change', onMudarPeriodo);
  document.getElementById('selMes').addEventListener('change', onMudarPeriodo);
  aoCruzarBreakpoint(() => render());
}

async function onMudarPeriodo(){
  anoSelecionado = Number(document.getElementById('selAno').value);
  mesSelecionado = Number(document.getElementById('selMes').value);
  await selecionarPeriodo();
}

async function selecionarPeriodo(){
  const resultado = await api(`/gastos/buscar?ano=${anoSelecionado}&mes=${mesSelecionado}`);
  mesAtual = resultado.existe ? resultado.mes : null;
  selecionados = new Set();
  editandoId = null;
  render();
}

// ---------- render principal (desktop: tabela / mobile: cards) ----------

function renderLinhaItem(item){
  const emEdicao = item.id === editandoId;
  const classes = 'item' + (emEdicao ? ' editando' : '');
  const chk = `<td class="chk-col"><input type="checkbox" class="chk chk-item" data-id="${item.id}" ${selecionados.has(item.id) ? 'checked' : ''}></td>`;

  if(emEdicao){
    return `
      <tr class="${classes}">
        ${chk}
        <td class="desc"><input type="text" class="input-edit input-nome" data-id="${item.id}" value="${escapeHtml(item.nome)}" placeholder="Nome"></td>
        <td class="detail"><input type="text" class="input-edit input-descricao" data-id="${item.id}" value="${escapeHtml(item.descricao || '')}" placeholder="Descrição (opcional)"></td>
        <td class="value-col"><input type="text" inputmode="decimal" class="input-edit input-valor input-moeda" data-id="${item.id}" value="${fmt(item.valor)}"></td>
        <td><input type="date" class="input-edit input-data-compra" data-id="${item.id}" value="${item.data_compra || ''}"></td>
        <td class="acoes-linha">
          <button class="icone-btn save-btn" data-id="${item.id}" title="Salvar">✓</button>
          <button class="icone-btn cancel-btn" data-id="${item.id}" title="Cancelar">↺</button>
        </td>
      </tr>
    `;
  }

  return `
    <tr class="${classes}">
      ${chk}
      <td class="desc">${escapeHtml(item.nome)}</td>
      <td class="detail">${item.descricao ? escapeHtml(item.descricao) : ''}</td>
      <td class="value-col"><span class="prefixo-moeda">R$ </span><span class="valor-mascaravel">${fmt(item.valor)}</span></td>
      <td class="vencimento">${formatarDataCurta(item.data_compra)}</td>
      <td class="acoes-linha">
        <button class="icone-btn edit-btn" data-id="${item.id}" title="Editar">✏️</button>
        <button class="icone-btn del-btn" data-id="${item.id}" title="Remover deste mês">✕</button>
      </td>
    </tr>
  `;
}

// mesma linha do item, so que em formato de card pra tela de celular —
// reaproveita as MESMAS classes interativas (chk-item, edit-btn, del-btn,
// save-btn, cancel-btn, input-*) da versao desktop, entao
// attachEventosTabela() funciona pras duas sem mudar nada.
function renderCardItem(item){
  const emEdicao = item.id === editandoId;
  const classes = 'item-card' + (emEdicao ? ' editando' : '');

  if(emEdicao){
    return `
      <div class="${classes}">
        <input type="text" class="input-edit input-nome" data-id="${item.id}" value="${escapeHtml(item.nome)}" placeholder="Nome">
        <input type="text" class="input-edit input-descricao" data-id="${item.id}" value="${escapeHtml(item.descricao || '')}" placeholder="Descrição (opcional)">
        <input type="text" inputmode="decimal" class="input-edit input-valor input-moeda" data-id="${item.id}" value="${fmt(item.valor)}" placeholder="Valor">
        <input type="date" class="input-edit input-data-compra" data-id="${item.id}" value="${item.data_compra || ''}">
        <div class="card-form-acoes">
          <button class="icone-btn save-btn card-btn-form" data-id="${item.id}">✓ Salvar</button>
          <button class="icone-btn cancel-btn card-btn-form" data-id="${item.id}">↺ Cancelar</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="${classes}">
      <div class="card-topo">
        <input type="checkbox" class="chk chk-item" data-id="${item.id}" ${selecionados.has(item.id) ? 'checked' : ''}>
        <div class="card-nome">${escapeHtml(item.nome)}</div>
      </div>
      ${item.descricao ? `<div class="card-detalhe">${escapeHtml(item.descricao)}</div>` : ''}
      <div class="card-valor-linha">
        <span class="card-valor"><span class="prefixo-moeda">R$ </span><span class="valor-mascaravel">${fmt(item.valor)}</span></span>
        <span class="card-data">${formatarDataCurta(item.data_compra)}</span>
      </div>
      <button class="icone-btn edit-btn card-btn-editar" data-id="${item.id}">✏️ Editar</button>
      <button class="icone-btn del-btn card-btn-remover" data-id="${item.id}">✕ Remover</button>
    </div>
  `;
}

function render(){
  const conteudo = document.getElementById('conteudo');
  const btnExcluir = document.getElementById('btnExcluirMes');
  const btnAdd = document.getElementById('btnAdd');
  const periodoInfo = document.getElementById('periodoInfo');

  if(!mesAtual){
    btnExcluir.disabled = true;
    btnAdd.disabled = true;
    periodoInfo.textContent = 'este mês ainda não existe';
    conteudo.innerHTML = `
      <div class="vazio">
        <div class="titulo">${MESES_NOMES[mesSelecionado-1]} / ${anoSelecionado} ainda não foi criado</div>
        <div>Clique abaixo para criar este mês — ele fica disponível tanto em Contas quanto em Gastos.</div>
        <button class="btn primary" id="btnCriarAqui">✨ Criar ${MESES_NOMES[mesSelecionado-1]} / ${anoSelecionado}</button>
      </div>
    `;
    document.getElementById('btnCriarAqui').onclick = () => criarMes(anoSelecionado, mesSelecionado);
    return;
  }

  btnExcluir.disabled = false;
  btnAdd.disabled = false;
  periodoInfo.textContent = `criado em ${mesAtual.criado_em}`;

  let html = `
    <div class="summary">
      <div class="card total"><div class="label">Total do mês</div><div class="value">R$ <span class="valor-mascaravel">${fmt(mesAtual.total)}</span></div></div>
      <div class="card selecao">
        <div class="label"><span id="labelSelecionado">Selecionado</span><button class="limpar-sel" id="btnLimparSelecao">limpar</button></div>
        <div class="value">R$ <span class="valor-mascaravel" id="valorSelecionado">0,00</span></div>
      </div>
    </div>
  `;

  if(mesAtual.itens.length === 0){
    html += `<div class="vazio">Nenhum gasto neste mês ainda. Use "+ Adicionar gasto" para começar.</div>`;
  } else if(ehMobile()){
    let cards = '';
    let categoriaAnterior = null;
    for(const item of mesAtual.itens){
      if(item.categoria !== categoriaAnterior){
        cards += `<div class="grupo-label-mobile"><label class="grupo-label"><input type="checkbox" class="chk chk-grupo" data-categoria="${escapeHtml(item.categoria)}"> ${escapeHtml(item.categoria)}</label></div>`;
        categoriaAnterior = item.categoria;
      }
      cards += renderCardItem(item);
    }
    html += `<div class="cards-lista">${cards}</div>`;
  } else {
    let linhas = '';
    let categoriaAnterior = null;
    for(const item of mesAtual.itens){
      if(item.categoria !== categoriaAnterior){
        linhas += `<tr class="group-header"><td colspan="6"><label class="grupo-label"><input type="checkbox" class="chk chk-grupo" data-categoria="${escapeHtml(item.categoria)}"> ${escapeHtml(item.categoria)}</label></td></tr>`;
        categoriaAnterior = item.categoria;
      }
      linhas += renderLinhaItem(item);
    }
    html += `
      <table>
        <thead>
          <tr>
            <th class="chk-col"><input type="checkbox" class="chk" id="chkTodos" title="Selecionar tudo"></th>
            <th style="width:24%">Nome</th>
            <th style="width:24%">Descrição</th>
            <th style="width:13%">Valor</th>
            <th style="width:14%">Data da compra</th>
            <th style="width:12%">Ações</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
    `;
  }

  conteudo.innerHTML = html;
  attachEventosTabela();
  atualizarResumoSelecao();
  atualizarCheckboxesGrupo();
}

function atualizarResumoSelecao(){
  const valorEl = document.getElementById('valorSelecionado');
  const labelEl = document.getElementById('labelSelecionado');
  if(!valorEl || !mesAtual) return;
  const itensSel = mesAtual.itens.filter(i => selecionados.has(i.id));
  const total = itensSel.reduce((s,i) => s + Number(i.valor), 0);
  valorEl.textContent = fmt(total);
  labelEl.textContent = itensSel.length === 0 ? 'Selecionado'
    : itensSel.length === 1 ? 'Selecionado (1 gasto)'
    : `Selecionado (${itensSel.length} gastos)`;
}

function atualizarCheckboxesGrupo(){
  if(!mesAtual) return;
  document.querySelectorAll('.chk-grupo').forEach(chkGrupo => {
    const idsGrupo = mesAtual.itens.filter(i => i.categoria === chkGrupo.dataset.categoria).map(i => i.id);
    const marcados = idsGrupo.filter(id => selecionados.has(id)).length;
    chkGrupo.checked = idsGrupo.length > 0 && marcados === idsGrupo.length;
    chkGrupo.indeterminate = marcados > 0 && marcados < idsGrupo.length;
  });
  const chkTodos = document.getElementById('chkTodos');
  if(chkTodos){
    const total = mesAtual.itens.length;
    const marcados = mesAtual.itens.filter(i => selecionados.has(i.id)).length;
    chkTodos.checked = total > 0 && marcados === total;
    chkTodos.indeterminate = marcados > 0 && marcados < total;
  }
}

function attachEventosTabela(){
  document.querySelectorAll('.chk-item').forEach(chk=>{
    chk.addEventListener('change', () => {
      const id = Number(chk.dataset.id);
      if(chk.checked) selecionados.add(id); else selecionados.delete(id);
      atualizarResumoSelecao();
      atualizarCheckboxesGrupo();
    });
  });

  document.querySelectorAll('.chk-grupo').forEach(chk=>{
    chk.addEventListener('change', () => {
      const idsGrupo = mesAtual.itens.filter(i => i.categoria === chk.dataset.categoria).map(i => i.id);
      idsGrupo.forEach(id => {
        if(chk.checked) selecionados.add(id); else selecionados.delete(id);
        const chkItem = document.querySelector(`.chk-item[data-id="${id}"]`);
        if(chkItem) chkItem.checked = chk.checked;
      });
      atualizarResumoSelecao();
      atualizarCheckboxesGrupo();
    });
  });

  const chkTodos = document.getElementById('chkTodos');
  if(chkTodos){
    chkTodos.addEventListener('change', () => {
      mesAtual.itens.forEach(item => {
        if(chkTodos.checked) selecionados.add(item.id); else selecionados.delete(item.id);
      });
      document.querySelectorAll('.chk-item').forEach(c => { c.checked = chkTodos.checked; });
      atualizarResumoSelecao();
      atualizarCheckboxesGrupo();
    });
  }

  const btnLimparSelecao = document.getElementById('btnLimparSelecao');
  if(btnLimparSelecao){
    btnLimparSelecao.addEventListener('click', () => {
      selecionados = new Set();
      document.querySelectorAll('.chk').forEach(c => { c.checked = false; c.indeterminate = false; });
      atualizarResumoSelecao();
    });
  }

  document.querySelectorAll('.del-btn').forEach(btn=>{
    btn.onclick = async () => {
      const id = Number(btn.dataset.id);
      const item = mesAtual.itens.find(i=>i.id===id);
      const rotuloItem = item.nome;
      if(confirm(`Remover "${rotuloItem}" deste mês? Isso não afeta outros meses no histórico.`)){
        try {
          mesAtual = await api('/gastos/' + id, { method:'DELETE' });
          render();
        } catch(e){ toast(e.message, 'erro'); }
      }
    };
  });

  document.querySelectorAll('.edit-btn').forEach(btn=>{
    btn.onclick = () => {
      editandoId = Number(btn.dataset.id);
      render();
      const campoNome = document.querySelector('.input-nome');
      if(campoNome){ campoNome.focus(); campoNome.select(); }
    };
  });

  document.querySelectorAll('.cancel-btn').forEach(btn=>{
    btn.onclick = () => {
      editandoId = null;
      render();
    };
  });

  document.querySelectorAll('.save-btn').forEach(btn=>{
    btn.onclick = () => salvarEdicao(Number(btn.dataset.id));
  });

  document.querySelectorAll('.input-valor').forEach(inp => ativarMascaraMoeda(inp));

  document.querySelectorAll('.input-edit').forEach(inp=>{
    inp.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter'){ e.preventDefault(); salvarEdicao(Number(inp.dataset.id)); }
      if(e.key === 'Escape'){ e.preventDefault(); editandoId = null; render(); }
    });
  });
}

async function salvarEdicao(id){
  const nome = document.querySelector('.input-nome').value.trim();
  const descricao = document.querySelector('.input-descricao').value.trim();
  const valor = parseValorBR(document.querySelector('.input-valor').value);
  const dataCompra = document.querySelector('.input-data-compra').value || null;
  if(!nome){ toast('O nome não pode ficar vazio.', 'erro'); return; }

  try {
    mesAtual = await api('/gastos/' + id, { method:'PATCH', body: JSON.stringify({ nome, descricao, valor, data_compra: dataCompra }) });
    editandoId = null;
    render();
  } catch(e){ toast(e.message, 'erro'); }
}

// ---------- criar / excluir mes (compartilhado com Contas) ----------

async function criarMes(ano, mes){
  try {
    await api('/meses', { method:'POST', body: JSON.stringify({ ano, mes }) });
    anoSelecionado = ano; mesSelecionado = mes;
    document.getElementById('selAno').value = ano;
    document.getElementById('selMes').value = mes;
    await selecionarPeriodo();
    toast(`${MESES_NOMES[mes-1]} / ${ano} criado! Já disponível em Contas e Gastos.`);
  } catch(e){ toast(e.message, 'erro'); }
}

document.getElementById('btnNovoMes').onclick = async () => {
  try {
    const sugestao = await api('/meses/sugestao');
    await criarMes(sugestao.ano, sugestao.mes);
  } catch(e){ toast(e.message, 'erro'); }
};

document.getElementById('btnExcluirMes').onclick = async () => {
  if(!mesAtual) return;
  const rotulo = mesAtual.rotulo;
  if(!confirm(`Excluir "${rotulo}" por completo? Isso apaga TODOS os lançamentos de Contas E todos os Gastos deste mês. Essa ação não pode ser desfeita.`)) return;
  try {
    await api('/meses/' + mesAtual.id, { method:'DELETE' });
    toast(`${rotulo} excluído.`);
    const lista = await api('/meses');
    if(lista.length > 0){
      anoSelecionado = lista[0].ano; mesSelecionado = lista[0].mes;
    } else {
      const sugestao = await api('/meses/sugestao');
      anoSelecionado = sugestao.ano; mesSelecionado = sugestao.mes;
    }
    document.getElementById('selAno').value = anoSelecionado;
    document.getElementById('selMes').value = mesSelecionado;
    await selecionarPeriodo();
  } catch(e){ toast(e.message, 'erro'); }
};

// ---------- adicionar gasto ----------

function popularSelectCategorias(selectEl){
  selectEl.innerHTML = categorias.map(c => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join('')
    + `<option value="__nova__">+ Nova categoria...</option>`;
  atualizarVisibilidadeNovaCategoria();
}

function atualizarVisibilidadeNovaCategoria(){
  const valor = document.getElementById('newCategoria').value;
  document.getElementById('newCategoriaNome').style.display = valor === '__nova__' ? 'inline-block' : 'none';
}

document.getElementById('btnAdd').onclick = () => {
  popularSelectCategorias(document.getElementById('newCategoria'));
  document.getElementById('newDataCompra').value = hojeIso();
  document.getElementById('painelCategorias').classList.remove('show');
  document.getElementById('addForm').classList.toggle('show');
};
document.getElementById('btnCancelNew').onclick = () => {
  document.getElementById('addForm').classList.remove('show');
};
document.getElementById('newCategoria').addEventListener('change', atualizarVisibilidadeNovaCategoria);
ativarMascaraMoeda(document.getElementById('newValor'));

document.getElementById('btnSaveNew').onclick = async () => {
  if(!mesAtual){ toast('Crie o mês antes de adicionar gastos.', 'erro'); return; }
  const categoriaSel = document.getElementById('newCategoria').value;
  const nomeGasto = document.getElementById('newNome').value.trim();
  const descricao = document.getElementById('newDesc').value.trim();
  const valor = parseValorBR(document.getElementById('newValor').value);
  const dataCompra = document.getElementById('newDataCompra').value || null;
  if(!categoriaSel){ toast('Selecione ou crie uma categoria.', 'erro'); return; }
  if(!nomeGasto){ toast('Informe o nome do gasto.', 'erro'); return; }

  const body = { mes_id: mesAtual.id, nome: nomeGasto, descricao, valor, data_compra: dataCompra };
  if(categoriaSel === '__nova__'){
    const nome = document.getElementById('newCategoriaNome').value.trim();
    if(!nome){ toast('Informe o nome da nova categoria.', 'erro'); return; }
    body.categoria_gasto_nome = nome;
  } else {
    body.categoria_gasto_id = Number(categoriaSel);
  }

  try {
    mesAtual = await api('/gastos', { method:'POST', body: JSON.stringify(body) });
    await carregarCategorias();
    document.getElementById('newNome').value = '';
    document.getElementById('newDesc').value = '';
    document.getElementById('newValor').value = '';
    document.getElementById('newCategoriaNome').value = '';
    document.getElementById('addForm').classList.remove('show');
    render();
  } catch(e){ toast(e.message, 'erro'); }
};

// ---------- categorias ----------

async function carregarCategorias(){
  categorias = await api('/categorias-gasto');
}

function renderCategoriasLista(){
  const container = document.getElementById('categoriasLista');
  if(categorias.length === 0){
    container.innerHTML = `<div style="color:var(--muted); font-size:13px;">Nenhuma categoria ainda.</div>`;
    return;
  }
  container.innerHTML = categorias.map((c, i) => `
    <div class="grupo-item" data-id="${c.id}">
      <input class="nome" value="${escapeHtml(c.nome)}" data-id="${c.id}">
      <span class="tag-uso">${c.emUso ? 'em uso' : 'sem gastos'}</span>
      <button class="mini-btn" data-acao="up" data-id="${c.id}" ${i===0 ? 'disabled' : ''}>▲</button>
      <button class="mini-btn" data-acao="down" data-id="${c.id}" ${i===categorias.length-1 ? 'disabled' : ''}>▼</button>
      <button class="mini-btn del" data-acao="del" data-id="${c.id}">🗑️</button>
    </div>
  `).join('');

  container.querySelectorAll('input.nome').forEach(inp => {
    inp.addEventListener('blur', async () => {
      const id = Number(inp.dataset.id);
      const nome = inp.value.trim();
      const atual = categorias.find(c => c.id === id);
      if(!nome || nome === atual.nome) { inp.value = atual.nome; return; }
      try {
        await api('/categorias-gasto/' + id, { method:'PATCH', body: JSON.stringify({ nome }) });
        await carregarCategorias();
        renderCategoriasLista();
        render();
      } catch(e){ toast(e.message, 'erro'); inp.value = atual.nome; }
    });
    inp.addEventListener('keydown', (e) => { if(e.key === 'Enter'){ e.preventDefault(); inp.blur(); } });
  });

  container.querySelectorAll('.mini-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const acao = btn.dataset.acao;
      try {
        if(acao === 'up' || acao === 'down'){
          await api(`/categorias-gasto/${id}/mover`, { method:'PATCH', body: JSON.stringify({ direcao: acao }) });
        } else if(acao === 'del'){
          const c = categorias.find(x => x.id === id);
          if(c.emUso){ toast('Esta categoria tem gastos no histórico — renomeie em vez de excluir.', 'erro'); return; }
          if(!confirm(`Excluir a categoria "${c.nome}"?`)) return;
          await api('/categorias-gasto/' + id, { method:'DELETE' });
        }
        await carregarCategorias();
        renderCategoriasLista();
        render();
      } catch(e){ toast(e.message, 'erro'); }
    });
  });
}

document.getElementById('btnCategorias').onclick = () => {
  document.getElementById('addForm').classList.remove('show');
  const painel = document.getElementById('painelCategorias');
  painel.classList.toggle('show');
  if(painel.classList.contains('show')) renderCategoriasLista();
};
document.getElementById('btnFecharCategorias').onclick = () => {
  document.getElementById('painelCategorias').classList.remove('show');
};
document.getElementById('btnNovaCategoria').onclick = async () => {
  const input = document.getElementById('novaCategoriaInput');
  const nome = input.value.trim();
  if(!nome){ toast('Informe um nome.', 'erro'); return; }
  try {
    await api('/categorias-gasto', { method:'POST', body: JSON.stringify({ nome }) });
    input.value = '';
    await carregarCategorias();
    renderCategoriasLista();
  } catch(e){ toast(e.message, 'erro'); }
};

configurarOcultarValores('controleGastosOcultarValores');
iniciar();
