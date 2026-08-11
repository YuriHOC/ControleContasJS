
let agrupamentos = [];
let mesAtual = null;   // mes carregado (com itens) ou null se nao existe ainda
let anoSelecionado = null;
let mesSelecionado = null;
let selecionados = new Set(); // ids de lancamentos marcados pra somar, so no mes atual
let editandoId = null; // id do lancamento em edicao no momento (so um por vez), ou null

async function iniciar(){
  popularSelects();
  await carregarUsuarioLogado();
  await carregarAgrupamentos();

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
  const resultado = await api(`/meses/buscar?ano=${anoSelecionado}&mes=${mesSelecionado}`);
  mesAtual = resultado.existe ? resultado.mes : null;
  selecionados = new Set();
  editandoId = null;
  render();
}

// ---------- render principal (desktop: tabela / mobile: cards) ----------

function renderLinhaItem(item){
  const emEdicao = item.id === editandoId;
  const classes = 'item' + (item.ok ? ' ok' : ' nao-pago') + (emEdicao ? ' editando' : '');
  const chk = `<td class="chk-col"><input type="checkbox" class="chk chk-item" data-id="${item.id}" ${selecionados.has(item.id) ? 'checked' : ''}></td>`;
  const fixoBtn = `<td><button class="fixo-btn ${item.fixo ? 'active' : ''}" data-id="${item.id}" data-fixo="${item.fixo ? '1':'0'}">${item.fixo ? '🔁 Fixo' : '＋ Fixar'}</button></td>`;
  const statusBtn = `<td><button class="status-btn ${item.ok ? 'ok' : ''}" data-id="${item.id}">${item.ok ? 'OK' : '-'}</button></td>`;

  if(emEdicao){
    return `
      <tr class="${classes}">
        ${chk}
        <td class="desc"><input type="text" class="input-edit input-descricao" data-id="${item.id}" value="${escapeHtml(item.descricao)}"></td>
        <td class="value-col"><input type="text" inputmode="decimal" class="input-edit input-valor input-moeda" data-id="${item.id}" value="${fmt(item.valor)}"></td>
        <td class="detail"><input type="text" class="input-edit input-detalhe" data-id="${item.id}" value="${escapeHtml(item.detalhe || '')}"></td>
        <td><input type="date" class="input-edit input-data-limite" data-id="${item.id}" value="${item.data_limite || ''}"></td>
        ${fixoBtn}
        ${statusBtn}
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
      <td class="desc">${escapeHtml(item.descricao)}</td>
      <td class="value-col"><span class="prefixo-moeda">R$ </span><span class="valor-mascaravel">${fmt(item.valor)}</span></td>
      <td class="detail">${escapeHtml(item.detalhe || '')}</td>
      <td class="vencimento">${formatarDataCurta(item.data_limite)}</td>
      ${fixoBtn}
      ${statusBtn}
      <td class="acoes-linha">
        <button class="icone-btn edit-btn" data-id="${item.id}" title="Editar">✏️</button>
        <button class="icone-btn del-btn" data-id="${item.id}" title="Remover deste mês">✕</button>
      </td>
    </tr>
  `;
}

// mesma linha do item, so que em formato de card pra tela de celular —
// reaproveita as MESMAS classes interativas (chk-item, status-btn,
// fixo-btn, edit-btn, del-btn, save-btn, cancel-btn, input-*) da versao
// desktop, entao attachEventosTabela() funciona pras duas sem mudar nada.
function renderCardItem(item){
  const emEdicao = item.id === editandoId;
  const classes = 'item-card' + (item.ok ? ' ok' : '') + (emEdicao ? ' editando' : '');

  if(emEdicao){
    return `
      <div class="${classes}">
        <input type="text" class="input-edit input-descricao" data-id="${item.id}" value="${escapeHtml(item.descricao)}" placeholder="Descrição">
        <input type="text" inputmode="decimal" class="input-edit input-valor input-moeda" data-id="${item.id}" value="${fmt(item.valor)}" placeholder="Valor">
        <input type="text" class="input-edit input-detalhe" data-id="${item.id}" value="${escapeHtml(item.detalhe || '')}" placeholder="Detalhes (opcional)">
        <input type="date" class="input-edit input-data-limite" data-id="${item.id}" value="${item.data_limite || ''}">
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
        <div class="card-nome">${escapeHtml(item.descricao)}</div>
      </div>
      ${item.detalhe ? `<div class="card-detalhe">${escapeHtml(item.detalhe)}</div>` : ''}
      <div class="card-valor-linha">
        <span class="card-valor"><span class="prefixo-moeda">R$ </span><span class="valor-mascaravel">${fmt(item.valor)}</span></span>
        <span class="card-data">vence ${formatarDataCurta(item.data_limite)}</span>
      </div>
      <div class="card-acoes-duplas">
        <button class="status-btn card-pill ${item.ok ? 'ok' : ''}" data-id="${item.id}">${item.ok ? 'OK' : 'Pendente'}</button>
        <button class="fixo-btn card-pill ${item.fixo ? 'active' : ''}" data-id="${item.id}" data-fixo="${item.fixo ? '1':'0'}">${item.fixo ? '🔁 Fixo' : '＋ Fixar'}</button>
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
        <div>Clique abaixo para criar este mês. As contas marcadas como fixas no mês mais recente já vêm incluídas automaticamente. Esse mês fica disponível tanto em Contas quanto em Gastos.</div>
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
      <div class="card total"><div class="label">Total do mês</div><div class="value">R$ <span class="valor-mascaravel">${fmt(mesAtual.totais.total)}</span></div></div>
      <div class="card paid"><div class="label">Pago (OK)</div><div class="value">R$ <span class="valor-mascaravel">${fmt(mesAtual.totais.pago)}</span></div></div>
      <div class="card pending"><div class="label">Pendente</div><div class="value">R$ <span class="valor-mascaravel">${fmt(mesAtual.totais.pendente)}</span></div></div>
      <div class="card selecao">
        <div class="label"><span id="labelSelecionado">Selecionado</span><button class="limpar-sel" id="btnLimparSelecao">limpar</button></div>
        <div class="value">R$ <span class="valor-mascaravel" id="valorSelecionado">0,00</span></div>
      </div>
    </div>
  `;

  if(mesAtual.itens.length === 0){
    html += `<div class="vazio">Nenhuma conta neste mês ainda. Use "+ Adicionar conta" para começar.</div>`;
  } else if(ehMobile()){
    let cards = '';
    let grupoAnterior = null;
    for(const item of mesAtual.itens){
      if(item.grupo !== grupoAnterior){
        cards += `<div class="grupo-label-mobile"><label class="grupo-label"><input type="checkbox" class="chk chk-grupo" data-grupo="${escapeHtml(item.grupo)}"> ${escapeHtml(item.grupo)}</label></div>`;
        grupoAnterior = item.grupo;
      }
      cards += renderCardItem(item);
    }
    html += `<div class="cards-lista">${cards}</div>`;
  } else {
    let linhas = '';
    let grupoAnterior = null;
    for(const item of mesAtual.itens){
      if(item.grupo !== grupoAnterior){
        linhas += `<tr class="group-header"><td colspan="8"><label class="grupo-label"><input type="checkbox" class="chk chk-grupo" data-grupo="${escapeHtml(item.grupo)}"> ${escapeHtml(item.grupo)}</label></td></tr>`;
        grupoAnterior = item.grupo;
      }
      linhas += renderLinhaItem(item);
    }
    html += `
      <table>
        <thead>
          <tr>
            <th class="chk-col"><input type="checkbox" class="chk" id="chkTodos" title="Selecionar tudo"></th>
            <th style="width:19%">Descrição</th>
            <th style="width:10%">Valor</th>
            <th style="width:14%">Detalhes</th>
            <th style="width:11%">Vencimento</th>
            <th style="width:11%">Fixo</th>
            <th style="width:10%">Status</th>
            <th style="width:9%">Ações</th>
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
    : itensSel.length === 1 ? 'Selecionado (1 conta)'
    : `Selecionado (${itensSel.length} contas)`;
}

function atualizarCheckboxesGrupo(){
  if(!mesAtual) return;
  document.querySelectorAll('.chk-grupo').forEach(chkGrupo => {
    const idsGrupo = mesAtual.itens.filter(i => i.grupo === chkGrupo.dataset.grupo).map(i => i.id);
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
      const idsGrupo = mesAtual.itens.filter(i => i.grupo === chk.dataset.grupo).map(i => i.id);
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

  document.querySelectorAll('.status-btn').forEach(btn=>{
    btn.onclick = async () => {
      const id = Number(btn.dataset.id);
      const item = mesAtual.itens.find(i=>i.id===id);
      try {
        mesAtual = await api('/lancamentos/' + id, { method:'PATCH', body: JSON.stringify({ ok: !item.ok }) });
        render();
      } catch(e){ toast(e.message, 'erro'); }
    };
  });

  document.querySelectorAll('.fixo-btn').forEach(btn=>{
    btn.onclick = async () => {
      const id = Number(btn.dataset.id);
      const fixoAtual = btn.dataset.fixo === '1';
      try {
        mesAtual = await api('/lancamentos/' + id + '/fixo', { method:'PATCH', body: JSON.stringify({ fixo: !fixoAtual }) });
        render();
        toast(fixoAtual ? 'Conta desmarcada como fixa.' : 'Conta marcada como fixa — vai se repetir no próximo mês.');
      } catch(e){ toast(e.message, 'erro'); }
    };
  });

  document.querySelectorAll('.del-btn').forEach(btn=>{
    btn.onclick = async () => {
      const id = Number(btn.dataset.id);
      const item = mesAtual.itens.find(i=>i.id===id);
      if(confirm(`Remover "${item.descricao}" deste mês? Isso não afeta outros meses no histórico.`)){
        try {
          mesAtual = await api('/lancamentos/' + id, { method:'DELETE' });
          render();
        } catch(e){ toast(e.message, 'erro'); }
      }
    };
  });

  document.querySelectorAll('.edit-btn').forEach(btn=>{
    btn.onclick = () => {
      editandoId = Number(btn.dataset.id);
      render();
      const campoDesc = document.querySelector('.input-descricao');
      if(campoDesc){ campoDesc.focus(); campoDesc.select(); }
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
  const descricao = document.querySelector('.input-descricao').value.trim();
  const valor = parseValorBR(document.querySelector('.input-valor').value);
  const detalhe = document.querySelector('.input-detalhe').value.trim();
  const dataLimite = document.querySelector('.input-data-limite').value || null;
  if(!descricao){ toast('A descrição não pode ficar vazia.', 'erro'); return; }

  try {
    mesAtual = await api('/lancamentos/' + id, { method:'PATCH', body: JSON.stringify({ descricao, valor, detalhe, data_limite: dataLimite }) });
    editandoId = null;
    render();
  } catch(e){ toast(e.message, 'erro'); }
}

// ---------- criar / excluir mes ----------

async function criarMes(ano, mes){
  try {
    mesAtual = await api('/meses', { method:'POST', body: JSON.stringify({ ano, mes }) });
    anoSelecionado = ano; mesSelecionado = mes;
    document.getElementById('selAno').value = ano;
    document.getElementById('selMes').value = mes;
    render();
    toast(`${MESES_NOMES[mes-1]} / ${ano} criado! Contas fixas já incluídas. Já disponível em Contas e Gastos.`);
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

// ---------- adicionar conta ----------

function popularSelectGrupos(selectEl){
  selectEl.innerHTML = agrupamentos.map(g => `<option value="${g.id}">${escapeHtml(g.nome)}</option>`).join('')
    + `<option value="__novo__">+ Novo agrupamento...</option>`;
  atualizarVisibilidadeNovoGrupo();
}

function atualizarVisibilidadeNovoGrupo(){
  const valor = document.getElementById('newGrupo').value;
  document.getElementById('newGrupoNome').style.display = valor === '__novo__' ? 'inline-block' : 'none';
}

document.getElementById('btnAdd').onclick = () => {
  popularSelectGrupos(document.getElementById('newGrupo'));
  document.getElementById('painelAgrupamentos').classList.remove('show');
  document.getElementById('addForm').classList.toggle('show');
};
document.getElementById('btnCancelNew').onclick = () => {
  document.getElementById('addForm').classList.remove('show');
};
document.getElementById('newGrupo').addEventListener('change', atualizarVisibilidadeNovoGrupo);
ativarMascaraMoeda(document.getElementById('newValor'));

document.getElementById('btnSaveNew').onclick = async () => {
  if(!mesAtual){ toast('Crie o mês antes de adicionar contas.', 'erro'); return; }
  const grupoSel = document.getElementById('newGrupo').value;
  const descricao = document.getElementById('newDesc').value.trim();
  const valor = parseValorBR(document.getElementById('newValor').value);
  const detalhe = document.getElementById('newDetail').value.trim();
  const dataLimite = document.getElementById('newDataLimite').value || null;
  const fixo = document.getElementById('newFixo').checked;
  if(!descricao){ toast('Informe a descrição.', 'erro'); return; }

  const body = { mes_id: mesAtual.id, descricao, valor, detalhe, data_limite: dataLimite, fixo };
  if(grupoSel === '__novo__'){
    const nome = document.getElementById('newGrupoNome').value.trim();
    if(!nome){ toast('Informe o nome do novo agrupamento.', 'erro'); return; }
    body.agrupamento_nome = nome;
  } else {
    body.agrupamento_id = Number(grupoSel);
  }

  try {
    mesAtual = await api('/lancamentos', { method:'POST', body: JSON.stringify(body) });
    await carregarAgrupamentos();
    document.getElementById('newDesc').value = '';
    document.getElementById('newValor').value = '';
    document.getElementById('newDetail').value = '';
    document.getElementById('newDataLimite').value = '';
    document.getElementById('newGrupoNome').value = '';
    document.getElementById('newFixo').checked = false;
    document.getElementById('addForm').classList.remove('show');
    render();
  } catch(e){ toast(e.message, 'erro'); }
};

// ---------- agrupamentos ----------

async function carregarAgrupamentos(){
  agrupamentos = await api('/agrupamentos');
}

function renderGruposLista(){
  const container = document.getElementById('gruposLista');
  if(agrupamentos.length === 0){
    container.innerHTML = `<div style="color:var(--muted); font-size:13px;">Nenhum agrupamento ainda.</div>`;
    return;
  }
  container.innerHTML = agrupamentos.map((g, i) => `
    <div class="grupo-item" data-id="${g.id}">
      <input class="nome" value="${escapeHtml(g.nome)}" data-id="${g.id}">
      <span class="tag-uso">${g.emUso ? 'em uso' : 'sem lançamentos'}</span>
      <button class="mini-btn" data-acao="up" data-id="${g.id}" ${i===0 ? 'disabled' : ''}>▲</button>
      <button class="mini-btn" data-acao="down" data-id="${g.id}" ${i===agrupamentos.length-1 ? 'disabled' : ''}>▼</button>
      <button class="mini-btn del" data-acao="del" data-id="${g.id}">🗑️</button>
    </div>
  `).join('');

  container.querySelectorAll('input.nome').forEach(inp => {
    inp.addEventListener('blur', async () => {
      const id = Number(inp.dataset.id);
      const nome = inp.value.trim();
      const atual = agrupamentos.find(g => g.id === id);
      if(!nome || nome === atual.nome) { inp.value = atual.nome; return; }
      try {
        await api('/agrupamentos/' + id, { method:'PATCH', body: JSON.stringify({ nome }) });
        await carregarAgrupamentos();
        renderGruposLista();
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
          await api(`/agrupamentos/${id}/mover`, { method:'PATCH', body: JSON.stringify({ direcao: acao }) });
        } else if(acao === 'del'){
          const g = agrupamentos.find(x => x.id === id);
          if(g.emUso){ toast('Este agrupamento tem lançamentos no histórico — renomeie em vez de excluir.', 'erro'); return; }
          if(!confirm(`Excluir o agrupamento "${g.nome}"?`)) return;
          await api('/agrupamentos/' + id, { method:'DELETE' });
        }
        await carregarAgrupamentos();
        renderGruposLista();
        render();
      } catch(e){ toast(e.message, 'erro'); }
    });
  });
}

document.getElementById('btnAgrupamentos').onclick = () => {
  document.getElementById('addForm').classList.remove('show');
  const painel = document.getElementById('painelAgrupamentos');
  painel.classList.toggle('show');
  if(painel.classList.contains('show')) renderGruposLista();
};
document.getElementById('btnFecharAgrupamentos').onclick = () => {
  document.getElementById('painelAgrupamentos').classList.remove('show');
};
document.getElementById('btnNovoGrupo').onclick = async () => {
  const input = document.getElementById('novoGrupoInput');
  const nome = input.value.trim();
  if(!nome){ toast('Informe um nome.', 'erro'); return; }
  try {
    await api('/agrupamentos', { method:'POST', body: JSON.stringify({ nome }) });
    input.value = '';
    await carregarAgrupamentos();
    renderGruposLista();
  } catch(e){ toast(e.message, 'erro'); }
};

configurarOcultarValores('controleContasOcultarValores');
iniciar();
