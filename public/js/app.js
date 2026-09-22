// ─── GLOBAL ERROR HANDLER ────────────────────────────────────────────────────
window.addEventListener('error', function(e) {
  console.error('Erro global:', e.message, 'em', e.filename, 'linha', e.lineno);
  const body = document.body;
  if (body) {
    body.style.background = '#fff';
    body.innerHTML = `<div style="padding:40px;font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#B33F3F">⚠ Erro ao carregar o sistema</h2>
      <p style="color:#666;margin:12px 0">Abra o Console do navegador (F12 → Console) e envie o erro para suporte.</p>
      <pre style="background:#FBEBEA;border:1px solid #E3BCBC;padding:16px;border-radius:8px;font-size:13px;color:#B33F3F;white-space:pre-wrap">${e.message}\n\nArquivo: ${e.filename}\nLinha: ${e.lineno}</pre>
      <button onclick="location.reload()" style="margin-top:16px;padding:10px 20px;background:#0E6E7A;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px">↺ Tentar novamente</button>
    </div>`;
  }
});

// ─── STATE & UTILS ────────────────────────────────────────────────────────────
const state = { user: null, cadastros: {}, transactions: [], transfers: [] };
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const MONTHS_S = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

const $ = id => document.getElementById(id);
const fmtBRL = v => 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtPct = v => (Number(v||0)*100).toFixed(1) + '%';
// Escapa texto vindo do usuário (cadastros, lançamentos, nome de usuário etc.) antes
// de jogar em innerHTML. Sem isso, alguém podia salvar um cliente/fornecedor com
// nome tipo "<img src=x onerror=...>" e rodar JS na tela de quem abrisse a lista.
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(path, method='GET', body=null) {
  const opts = { method, credentials: 'include', headers: {'Content-Type':'application/json'} };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch('/api'+path, opts);
    const data = await res.json().catch(()=>({}));
    if (res.status === 401) { showAuth(); return {}; }
    return data;
  } catch(e) {
    console.error('API error:', path, e);
    return {};
  }
}

document.addEventListener('DOMContentLoaded', function() {

// ─── AUTH ─────────────────────────────────────────────────────────────────────
// Fluxo inicial: a tela que abre é sempre a de login. O formulário de cadastro
// só some quando o sistema já tem pelo menos um usuário — o cadastro "de primeira
// vez" (bootstrap do admin) aparece automaticamente apenas se o banco estiver vazio.
// Cadastro de novos usuários no dia a dia acontece de dentro do sistema, em
// Usuários (painel), e exige um admin logado.
async function checkAuth() {
  const user = await api('/auth/me');
  if (user && user.id) { state.user = user; initApp(); } else await showAuth();
}
async function showAuth() {
  $('auth-screen').classList.remove('hidden'); $('app').classList.add('hidden');
  const status = await api('/auth/setup-status');
  const needsSetup = !!(status && status.needsSetup);
  $('login-form').classList.toggle('hidden', needsSetup);
  $('setup-form').classList.toggle('hidden', !needsSetup);
}
function initApp() {
  $('auth-screen').classList.add('hidden'); $('app').classList.remove('hidden');
  $('user-name').textContent = state.user.nome || state.user.username;
  $('user-role').textContent = state.user.role === 'admin' ? 'Administrador' : 'Usuário';
  renderAvatar($('user-avatar'), state.user);
  if (state.user.role === 'admin') { $('nav-users').style.display = ''; $('nav-logs').style.display = ''; }
  else { $('nav-users').style.display = 'none'; $('nav-logs').style.display = 'none'; }
  aplicarPermissoesNav();
  populateYearSelects();
  loadCadastros().then(() => navigateTo(primeiraPaginaPermitida()));
}

// Mostra a foto de perfil (se tiver) ou a inicial do nome/usuário, num círculo.
function renderAvatar(el, user) {
  if (!el) return;
  if (user && user.foto_path) {
    el.innerHTML = `<img src="${user.foto_path}" alt="foto de perfil"/>`;
  } else {
    el.innerHTML = '';
    el.textContent = ((user && (user.nome || user.username)) || '?')[0].toUpperCase();
  }
}

$('btn-login') && $('btn-login').addEventListener('click', async () => {
  const r = await api('/auth/login','POST',{username:$('login-user').value.trim(),password:$('login-pass').value});
  if (r.error) { $('login-error').textContent=r.error; return; }
  state.user=r; initApp();
});
$('btn-setup') && $('btn-setup').addEventListener('click', async () => {
  const r = await api('/auth/register','POST',{username:$('setup-user').value.trim(),password:$('setup-pass').value});
  if (r.error) { $('setup-error').textContent=r.error; return; }
  state.user=r; initApp();
});
$('btn-logout') && $('btn-logout').addEventListener('click', async () => { await api('/auth/logout','POST'); state.user=null; showAuth(); });

// ─── PERFIL DO USUÁRIO ──────────────────────────────────────────────────────────
function openProfileScreen() {
  $('perfil-username').value = state.user.username;
  $('perfil-nome').value = state.user.nome || '';
  $('perfil-password').value = '';
  $('perfil-foto-input').value = '';
  $('perfil-error').textContent = '';
  renderAvatar($('perfil-foto-preview'), state.user);
  navigateTo('perfil');
}
$('btn-open-profile') && $('btn-open-profile').addEventListener('click', openProfileScreen);
$('btn-cancel-perfil') && $('btn-cancel-perfil').addEventListener('click', () => navigateTo('dashboard'));

$('perfil-foto-input') && $('perfil-foto-input').addEventListener('change', () => {
  const f = $('perfil-foto-input').files[0];
  if (!f) return;
  $('perfil-foto-preview').innerHTML = `<img src="${URL.createObjectURL(f)}" alt="foto de perfil"/>`;
});

// Igual aos anexos de parceiros: precisa de multipart/form-data pra mandar a
// foto, então não dá pra usar o helper api() (que só manda JSON).
$('btn-save-perfil') && $('btn-save-perfil').addEventListener('click', async () => {
  const senha = $('perfil-password').value;
  if (senha && senha.length < 4) { $('perfil-error').textContent = 'A nova senha deve ter ao menos 4 caracteres.'; return; }
  const fd = new FormData();
  fd.append('nome', $('perfil-nome').value.trim());
  if (senha) fd.append('password', senha);
  const fotoFile = $('perfil-foto-input').files[0];
  if (fotoFile) fd.append('foto', fotoFile);

  try {
    const res  = await fetch('/api/auth/profile', { method: 'PUT', credentials: 'include', body: fd });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showAuth(); return; }
    if (data.error) { $('perfil-error').textContent = 'Erro: ' + data.error; return; }
    state.user = data;
    $('user-name').textContent = state.user.nome || state.user.username;
    renderAvatar($('user-avatar'), state.user);
    navigateTo('dashboard');
  } catch (e) {
    $('perfil-error').textContent = 'Erro ao salvar perfil.';
  }
});

// ─── THEME TOGGLE (claro/escuro) ───────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('dre-theme', theme); } catch (e) {}
}
$('theme-toggle') && $('theme-toggle').addEventListener('click', () => {
  const atual = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(atual === 'dark' ? 'light' : 'dark');
});

// ─── NAVIGATION ───────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', e => {
  e.preventDefault(); navigateTo(item.dataset.page);
}));

// Telas que podem ser liberadas seletivamente pra um usuário não-admin (espelha
// a mesma lista do server.js). Dashboard e Perfil ficam sempre acessíveis.
const PAGINAS_PERMISSAO = [
  { key:'dashboard',              label:'Dashboard' },
  { key:'lancamentos',            label:'Lançamentos (Receitas, Despesas e Transferências)' },
  { key:'dre-resumo',             label:'DRE Resumo' },
  { key:'dre-detalhado',          label:'DRE Detalhado' },
  { key:'fluxo-caixa',            label:'Fluxo de Caixa' },
  { key:'formas-pagamento-rel',   label:'Formas de Pagamento (Relatório)' },
  { key:'cad-clientes',           label:'Clientes' },
  { key:'cad-fornecedores',       label:'Fornecedores' },
  { key:'cad-parceiros',          label:'Parceiros' },
  { key:'cad-caixas',             label:'Caixa / Banco' },
  { key:'cad-formas',             label:'Formas de Pagamento (Cadastro)' },
  { key:'import',                 label:'Importar / Exportar' },
];
const PAGINAS_SEMPRE_LIBERADAS = ['perfil'];

function podeAcessarPagina(page) {
  if (!state.user) return false;
  if (state.user.role === 'admin') return true;
  if (PAGINAS_SEMPRE_LIBERADAS.includes(page)) return true;
  return (state.user.permissoes || []).includes(page);
}

// Esconde do menu qualquer tela que o usuário não tenha permissão de ver.
// nav-users/nav-logs continuam controlados só pela função (admin), à parte disso.
function aplicarPermissoesNav() {
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    const page = item.dataset.page;
    if (page === 'users' || page === 'logs') return;
    item.style.display = podeAcessarPagina(page) ? '' : 'none';
  });
}

const pageLoaders = {
  dashboard: loadDashboard,
  lancamentos: () => { setLancSubtab('tx'); loadTransactions(true); },
  'dre-resumo': loadDREResumo,
  'dre-detalhado': loadDREDetalhado,
  'fluxo-caixa': loadFluxoCaixa,
  'formas-pagamento-rel': loadFormasPagamentoRel,
  'cad-clientes': () => loadCad('clientes'),
  'cad-fornecedores': () => loadCad('fornecedores'),
  'cad-parceiros': loadParceiros,
  'cad-caixas': () => loadCad('caixas'),
  'cad-formas': () => loadCad('formas_pagamento'),
  import: () => setDocSubtab('contrato_parceiro'),
  users: loadUsers,
  logs: () => loadLogs(1),
};

// Primeira tela que o usuário tem permissão de ver — usada como destino padrão
// no login e como "válvula de escape" quando ele tenta acessar algo vedado.
function primeiraPaginaPermitida() {
  if (!state.user) return 'perfil';
  if (state.user.role === 'admin') return 'dashboard';
  if ((state.user.permissoes || []).includes('dashboard')) return 'dashboard';
  const outra = PAGINAS_PERMISSAO.find(p => (state.user.permissoes || []).includes(p.key));
  return outra ? outra.key : 'perfil';
}

function navigateTo(page) {
  if (!podeAcessarPagina(page)) page = primeiraPaginaPermitida();
  state.page = page;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  if (pageLoaders[page]) pageLoaders[page]();
}

// ─── YEAR SELECTS ─────────────────────────────────────────────────────────────
function populateYearSelects() {
  const cur = new Date().getFullYear();
  const years = [cur-1, cur, cur+1];
  ['dre-year','resumo-year','det-year','fp-year','export-year'].forEach(id => {
    const el=$(id); if(!el) return;
    el.innerHTML = years.map(y=>`<option value="${y}" ${y===cur?'selected':''}>${y}</option>`).join('');
  });
  ['filter-year','tr-filter-year','fluxo-year'].forEach(id => {
    const el=$(id); if(!el) return;
    el.innerHTML = `<option value="">Todos os anos</option>` + years.map(y=>`<option value="${y}" ${y===cur?'selected':''}>${y}</option>`).join('');
  });
  // fluxo-month: set current month
  const fm = $('fluxo-month');
  if (fm) fm.value = String(new Date().getMonth()+1).padStart(2,'0');
}

// ─── CADASTROS ────────────────────────────────────────────────────────────────
async function loadCadastros() {
  state.cadastros = await api('/cadastros');
  populateTxSelects();
  populateCaixaSelects();
}

function populateTxSelects() {
  const { formasPagamento=[], caixasBancos=[], centrosCusto=[], clientes=[], fornecedores=[] } = state.cadastros;
  const fill = (id, opts, blank='—') => { const el=$(id); if(!el) return; el.innerHTML=`<option value="">${blank}</option>`+opts.map(o=>`<option value="${o}">${o}</option>`).join(''); };
  fill('tx-forma', formasPagamento);
  fill('tx-caixa', caixasBancos);
  fill('tx-centro', centrosCusto, 'Selecione...');
  // clientes + fornecedores merged
  const all = [...new Set([...clientes, ...fornecedores])];
  fill('tx-cliente', all);
}

function populateCaixaSelects() {
  const caixas = (state.cadastros.caixasBancos||[]);
  ['tr-saida','tr-entrada'].forEach(id => {
    const el=$(id); if(!el) return;
    el.innerHTML = `<option value="">—</option>` + caixas.map(c=>`<option value="${c}">${c}</option>`).join('');
  });
  const fc = $('fluxo-caixa');
  if (fc) fc.innerHTML = `<option value="Todos">Todos os caixas</option>` + caixas.map(c=>`<option value="${c}">${c}</option>`).join('');
}

// Contas e centros de custo dinâmicos no modal de lançamento
const CENTROS_RECEITA = ['RECEITA VENDAS','RECEITA OPERACIONAL','RECEITA COMUM'];
const CENTROS_DESPESA = ['DESPESAS OPERACIONAIS','DESPESAS DE IMPOSTOS','DESPESAS ADMINISTRATIVAS','ADMINISTRATIVO'];

function updateContasByTipo() {
  const tipo = $('tx-type').value;
  const grupo = $('tx-grupo').value;

  // Filtra Centro de Custo por tipo
  const todosCC = state.cadastros.centrosCusto || [];
  const ccFiltrados = tipo === 'income'
    ? todosCC.filter(c => CENTROS_RECEITA.includes(c))
    : todosCC.filter(c => CENTROS_DESPESA.includes(c));
  const centroEl = $('tx-centro');
  centroEl.innerHTML = `<option value="">Selecione...</option>` +
    ccFiltrados.map(c => `<option value="${c}">${c}</option>`).join('');

  // Filtra Grupos por tipo
  const grupos = tipo==='income' ? (state.cadastros.gruposContasReceita||[]) : (state.cadastros.gruposContasDespesa||[]);
  const allContas = tipo==='income' ? (state.cadastros.contasReceita||[]) : (state.cadastros.contasDespesa||[]);
  const gEl = $('tx-grupo');
  gEl.innerHTML = `<option value="">—</option>` + grupos.map(g=>`<option value="${g}">${g}</option>`).join('');
  if (grupo) gEl.value = grupo;
  updateContasByGrupo(tipo, grupo, allContas);
}

function updateContasByGrupo(tipo, grupo, allContas) {
  const contas = grupo ? allContas.filter(c=>c.grupo===grupo).map(c=>c.conta) : allContas.map(c=>c.conta);
  const el=$('tx-conta');
  el.innerHTML=`<option value="">—</option>`+[...new Set(contas)].map(c=>`<option value="${c}">${c}</option>`).join('');
}

$('tx-type') && $('tx-type').addEventListener('change', () => updateContasByTipo());
$('tx-grupo') && $('tx-grupo').addEventListener('change', () => {
  const tipo=$('tx-type').value;
  const all = tipo==='income' ? (state.cadastros.contasReceita||[]) : (state.cadastros.contasDespesa||[]);
  updateContasByGrupo(tipo, $('tx-grupo').value, all);
});
$('tx-forma') && $('tx-forma').addEventListener('change', calcTaxaPreview);
$('tx-amount') && $('tx-amount').addEventListener('input', calcTaxaPreview);

function calcTaxaPreview() {
  const forma = $('tx-forma').value;
  const amount = parseFloat($('tx-amount').value)||0;
  if (!forma || !amount) { $('taxa-preview').classList.add('hidden'); return; }
  // local estimate from cadastros
  const fp = (state.cadastros._formasFull||[]).find(f=>f.nome===forma);
  if (!fp) { $('taxa-preview').classList.add('hidden'); return; }
  const taxa = ((fp.taxa_intermediacao||0)/100)*amount + (fp.tarifa_fixa||0);
  $('taxa-valor').textContent = fmtBRL(taxa);
  $('taxa-liquido').textContent = fmtBRL(amount-taxa);
  $('taxa-preview').classList.remove('hidden');
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
async function loadDashboard() {
  const year=$('dre-year').value;
  const data = await api(`/dre?year=${year}`);
  const lines = data.dreLines || {};
  const receitaBruta = lines['Receita Bruta'] || 0;
  const despesas     = lines['(-) Despesas Operacionais'] || 0;
  const lucro        = lines['Lucro / Prejuízo Líquido'] || 0;
  $('kpi-receita').textContent=fmtBRL(receitaBruta);
  $('kpi-despesa').textContent=fmtBRL(despesas);
  $('kpi-lucro').textContent=fmtBRL(lucro);
  $('kpi-lucro').style.color=lucro>=0?'var(--green)':'var(--red)';
  $('kpi-margem').textContent=receitaBruta>0?fmtPct(lucro/receitaBruta):'0%';
  renderDRETable(lines);
  renderMonthlyTable(data.summary);
  renderChart(data.summary);
  renderDonutChart(data.summary, data.expensesByCategory || {});
  renderSaldoChart(data.summary);
  renderBarrasChart(data.summary);
  renderStatusCaixa(data.summary, lines);
}
$('dre-year') && $('dre-year').addEventListener('change', loadDashboard);

function renderDRETable(lines) {
  const rows=[
    {label:'Receita Bruta',key:'Receita Bruta',bold:true,cls:'positive'},
    {label:'(−) Impostos e Deduções',key:'(-) Impostos e Deduções',cls:'negative'},
    {label:'Receita Líquida',key:'Receita Líquida',bold:true},
    {label:'(−) Despesas Operacionais',key:'(-) Despesas Operacionais',cls:'negative'},
    {label:'Lucro / Prejuízo Líquido',key:'Lucro / Prejuízo Líquido',bold:true,total:true},
  ];
  $('dre-table').innerHTML=rows.map(r=>{
    const v=lines[r.key]||0;
    const valCls=r.total?(v>=0?'positive':'negative'):(r.cls||'');
    return `<div class="dre-row ${r.bold?'bold':''} ${r.total?'total':''} ${valCls}">
      <span class="dre-label">${r.label}</span>
      <span class="dre-value">${fmtBRL(r.cls==='negative'?-v:v)}</span>
    </div>`;
  }).join('');
}

function renderMonthlyTable(summary) {
  const mtbody=document.querySelector('#monthly-table tbody'); if(!mtbody) return;
  mtbody.innerHTML=summary.map(m=>{
    const cls=m.saldo>0?'val-pos':m.saldo<0?'val-neg':'val-0';
    return `<tr><td>${m.month}</td><td class="val-pos">${fmtBRL(m.receitas)}</td><td class="val-neg">${fmtBRL(m.despesas)}</td><td class="${cls}">${fmtBRL(m.saldo)}</td></tr>`;
  }).join('');
}

function renderChart(summary) {
  const canvas=$('chart-canvas'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  canvas.width=canvas.offsetWidth||500; canvas.height=260;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const W=canvas.width,H=canvas.height,pad={top:24,right:20,bottom:40,left:72};
  const cW=W-pad.left-pad.right,cH=H-pad.top-pad.bottom;
  const recs=summary.map(m=>m.receitas),desps=summary.map(m=>m.despesas);
  const maxVal=Math.max(...recs,...desps,1);
  const x=i=>pad.left+(i/11)*cW, y=v=>pad.top+cH-(v/maxVal)*cH;
  // Grid
  ctx.strokeStyle='#E4E9E2'; ctx.lineWidth=1;
  for(let i=0;i<=4;i++){
    const yy=pad.top+(i/4)*cH;
    ctx.beginPath();ctx.moveTo(pad.left,yy);ctx.lineTo(W-pad.right,yy);ctx.stroke();
    ctx.fillStyle='#93A398';ctx.font='10px Inter,sans-serif';ctx.textAlign='right';
    ctx.fillText(fmtBRL((1-i/4)*maxVal).replace('R$ ',''),pad.left-6,yy+4);
  }
  // Areas
  const drawArea=(vals,color)=>{
    ctx.beginPath();ctx.moveTo(x(0),y(vals[0]));
    vals.forEach((v,i)=>{if(i>0)ctx.lineTo(x(i),y(v))});
    ctx.lineTo(x(11),pad.top+cH);ctx.lineTo(x(0),pad.top+cH);ctx.closePath();
    ctx.fillStyle=color+'18';ctx.fill();
  };
  drawArea(recs,'#147A4A');drawArea(desps,'#B33F3F');
  // Lines
  const drawLine=(vals,color)=>{
    ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.lineJoin='round';ctx.lineCap='round';
    vals.forEach((v,i)=>i===0?ctx.moveTo(x(i),y(v)):ctx.lineTo(x(i),y(v)));ctx.stroke();
    vals.forEach((v,i)=>{ctx.beginPath();ctx.arc(x(i),y(v),3.5,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();});
  };
  drawLine(recs,'#147A4A');drawLine(desps,'#B33F3F');
  ctx.fillStyle='#5E6E63';ctx.font='10px Inter,sans-serif';ctx.textAlign='center';
  MONTHS_S.forEach((m,i)=>ctx.fillText(m,x(i),H-8));
}

// ─── DONUT: Distribuição de Despesas ──────────────────────────────────────────
function renderDonutChart(summary, expensesByCategory) {
  const canvas=$('chart-donut'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const SIZE=220; canvas.width=SIZE; canvas.height=SIZE;
  ctx.clearRect(0,0,SIZE,SIZE);

  // Montar categorias a partir do summary se expensesByCategory vazio
  let cats = {};
  if (expensesByCategory && Object.keys(expensesByCategory).length) {
    cats = expensesByCategory;
  } else {
    // Fallback: usar grupos genéricos do summary
    summary.forEach(m=>{
      const key = m.month;
      if (m.despesas>0) cats[key]=(cats[key]||0)+m.despesas;
    });
  }

  const entries = Object.entries(cats).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).slice(0,7);
  const total = entries.reduce((s,[,v])=>s+v,0);

  const COLORS=['#0E6E7A','#B33F3F','#B98B2E','#147A4A','#6B5CA5','#B0577D','#5E6E63'];

  if(!total || !entries.length){
    ctx.fillStyle='#E1E6DF';ctx.beginPath();ctx.arc(SIZE/2,SIZE/2,80,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#93A398';ctx.font='12px Inter,sans-serif';ctx.textAlign='center';
    ctx.fillText('Sem dados',SIZE/2,SIZE/2+4);
    if($('donut-legend')) $('donut-legend').innerHTML='';
    if($('donut-subtitle')) $('donut-subtitle').textContent='';
    return;
  }

  const cx=SIZE/2,cy=SIZE/2,outerR=92,innerR=52;
  let startAngle=-Math.PI/2;
  entries.forEach(([label,val],i)=>{
    const slice=(val/total)*Math.PI*2;
    ctx.beginPath();
    ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,outerR,startAngle,startAngle+slice);
    ctx.closePath();
    ctx.fillStyle=COLORS[i%COLORS.length];
    ctx.fill();
    ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();
    startAngle+=slice;
  });
  // Hole
  ctx.beginPath();ctx.arc(cx,cy,innerR,0,Math.PI*2);
  ctx.fillStyle='#fff';ctx.fill();
  // Center text
  ctx.fillStyle='#16231B';ctx.font='bold 13px Inter,sans-serif';ctx.textAlign='center';
  ctx.fillText(fmtBRL(total).replace('R$ ','R$'),cx,cy-4);
  ctx.fillStyle='#93A398';ctx.font='10px Inter,sans-serif';
  ctx.fillText('total despesas',cx,cy+14);

  // Legend
  const legendEl=$('donut-legend');
  if(legendEl){
    legendEl.innerHTML=entries.map(([label,val],i)=>`
      <div class="donut-legend-item">
        <span class="donut-legend-dot" style="background:${COLORS[i%COLORS.length]}"></span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${label}">${label}</span>
        <span class="donut-legend-pct">${((val/total)*100).toFixed(1)}%</span>
      </div>`).join('');
  }
  if($('donut-subtitle')) $('donut-subtitle').textContent=`${entries.length} categoria${entries.length>1?'s':''}`;
}

// ─── ÁREA: Saldo Acumulado ─────────────────────────────────────────────────────
function renderSaldoChart(summary) {
  const canvas=$('chart-saldo'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  canvas.width=canvas.offsetWidth||340; canvas.height=220;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const W=canvas.width,H=canvas.height,pad={top:20,right:16,bottom:36,left:68};
  const cW=W-pad.left-pad.right,cH=H-pad.top-pad.bottom;

  // Calcular saldo acumulado
  let acc=0;
  const saldos=summary.map(m=>{acc+=m.saldo;return acc;});
  const minS=Math.min(...saldos,0), maxS=Math.max(...saldos,0);
  const range=maxS-minS||1;
  const x=i=>pad.left+(i/11)*cW;
  const y=v=>pad.top+cH-((v-minS)/range)*cH;
  const zero=y(0);

  // Grid
  ctx.strokeStyle='#E4E9E2';ctx.lineWidth=1;
  for(let i=0;i<=4;i++){
    const yy=pad.top+(i/4)*cH;
    ctx.beginPath();ctx.moveTo(pad.left,yy);ctx.lineTo(W-pad.right,yy);ctx.stroke();
    const val=minS+((1-i/4)*range);
    ctx.fillStyle='#93A398';ctx.font='9px Inter,sans-serif';ctx.textAlign='right';
    ctx.fillText(fmtBRL(val).replace('R$ ',''),pad.left-4,yy+3);
  }

  // Zero line
  if(minS<0 && maxS>0){
    ctx.save();ctx.strokeStyle='#C9D2C7';ctx.setLineDash([4,4]);ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(pad.left,zero);ctx.lineTo(W-pad.right,zero);ctx.stroke();
    ctx.restore();
  }

  // Gradient fill
  const gradient=ctx.createLinearGradient(0,pad.top,0,pad.top+cH);
  gradient.addColorStop(0,'rgba(14,110,122,0.22)');
  gradient.addColorStop(1,'rgba(14,110,122,0.02)');
  ctx.beginPath();ctx.moveTo(x(0),y(saldos[0]));
  saldos.forEach((v,i)=>{if(i>0)ctx.lineTo(x(i),y(v))});
  ctx.lineTo(x(11),pad.top+cH);ctx.lineTo(x(0),pad.top+cH);ctx.closePath();
  ctx.fillStyle=gradient;ctx.fill();

  // Line
  ctx.beginPath();ctx.strokeStyle='#0E6E7A';ctx.lineWidth=2.5;ctx.lineJoin='round';ctx.lineCap='round';
  saldos.forEach((v,i)=>i===0?ctx.moveTo(x(i),y(v)):ctx.lineTo(x(i),y(v)));ctx.stroke();
  // Dots
  saldos.forEach((v,i)=>{
    ctx.beginPath();ctx.arc(x(i),y(v),3,0,Math.PI*2);
    ctx.fillStyle=v>=0?'#0E6E7A':'#B33F3F';ctx.fill();
    ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();
  });

  ctx.fillStyle='#5E6E63';ctx.font='9px Inter,sans-serif';ctx.textAlign='center';
  MONTHS_S.forEach((m,i)=>ctx.fillText(m,x(i),H-6));
}

// ─── BARRAS: Comparativo Mensal ────────────────────────────────────────────────
function renderBarrasChart(summary) {
  const canvas=$('chart-barras'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  canvas.width=canvas.offsetWidth||340; canvas.height=220;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const W=canvas.width,H=canvas.height,pad={top:20,right:16,bottom:36,left:68};
  const cW=W-pad.left-pad.right,cH=H-pad.top-pad.bottom;

  const recs=summary.map(m=>m.receitas),desps=summary.map(m=>m.despesas);
  const maxVal=Math.max(...recs,...desps,1);
  const slotW=cW/12;
  const barW=Math.max(4,slotW*0.35);

  // Grid
  ctx.strokeStyle='#E4E9E2';ctx.lineWidth=1;
  for(let i=0;i<=4;i++){
    const yy=pad.top+(i/4)*cH;
    ctx.beginPath();ctx.moveTo(pad.left,yy);ctx.lineTo(W-pad.right,yy);ctx.stroke();
    ctx.fillStyle='#93A398';ctx.font='9px Inter,sans-serif';ctx.textAlign='right';
    ctx.fillText(fmtBRL((1-i/4)*maxVal).replace('R$ ',''),pad.left-4,yy+3);
  }

  summary.forEach((m,i)=>{
    const cx=pad.left+slotW*i+slotW/2;
    const recH=(m.receitas/maxVal)*cH;
    const despH=(m.despesas/maxVal)*cH;

    // Receita (esquerda do par)
    ctx.fillStyle='#147A4A';
    ctx.beginPath();
    ctx.roundRect?ctx.roundRect(cx-barW-1,pad.top+cH-recH,barW,recH,2):
      ctx.rect(cx-barW-1,pad.top+cH-recH,barW,recH);
    ctx.fill();

    // Despesa (direita do par)
    ctx.fillStyle='#B33F3F';
    ctx.beginPath();
    ctx.roundRect?ctx.roundRect(cx+1,pad.top+cH-despH,barW,despH,2):
      ctx.rect(cx+1,pad.top+cH-despH,barW,despH);
    ctx.fill();
  });

  ctx.fillStyle='#5E6E63';ctx.font='9px Inter,sans-serif';ctx.textAlign='center';
  MONTHS_S.forEach((m,i)=>ctx.fillText(m,pad.left+slotW*i+slotW/2,H-6));
}

$('btn-export-pdf') && $('btn-export-pdf').addEventListener('click', ()=>window.open(`/api/export/pdf?year=${($('dre-year')||{value:new Date().getFullYear()}).value}`,'_blank'));
$('btn-export-excel') && $('btn-export-excel').addEventListener('click', ()=>window.open(`/api/export/excel?year=${($('dre-year')||{value:new Date().getFullYear()}).value}`,'_blank'));

// Re-renderiza gráficos ao redimensionar janela
let _resizeTimer;
window.addEventListener('resize', ()=>{
  clearTimeout(_resizeTimer);
  _resizeTimer=setTimeout(()=>{ if(state.page==='dashboard') loadDashboard(); },300);
});

// ─── RF05: STATUS DE CAIXA ────────────────────────────────────────────────────
async function renderStatusCaixa(summary, dreLines) {
  const bar = $('status-caixa-bar');
  const content = $('status-caixa-content');
  const alertasEl = $('status-caixa-alertas');
  if (!bar) return;

  const saldoAcum = summary.reduce((s,m)=>s+m.saldo, 0);

  // Buscar vencimentos para alertas
  const [atrasados, hoje] = await Promise.all([
    fetchContasStatus('atrasado'),
    fetchContasStatus('hoje'),
  ]);
  const qtAtraso = atrasados.length;
  const qtHoje = hoje.length;
  const vlAtraso = atrasados.reduce((s,t)=>s+Number(t.amount||0),0);

  bar.classList.remove('hidden','positivo','negativo','neutro');
  let statusCls, badgeCls, badgeLabel, msg;

  if (saldoAcum > 0) {
    statusCls='positivo'; badgeCls='ok'; badgeLabel='✓ Caixa Positivo';
    msg=`Saldo acumulado do período: <strong>${fmtBRL(saldoAcum)}</strong>`;
  } else if (saldoAcum < 0) {
    statusCls='negativo'; badgeCls='alerta'; badgeLabel='⚠ Caixa Negativo';
    msg=`Necessidade financeira identificada: <strong style="color:#B33F3F">${fmtBRL(Math.abs(saldoAcum))}</strong> abaixo do zero`;
  } else {
    statusCls='neutro'; badgeCls='neutro'; badgeLabel='— Saldo Neutro';
    msg='Sem movimentações no período selecionado';
  }

  bar.classList.add(statusCls);
  content.innerHTML=`<span class="status-badge ${badgeCls}">${badgeLabel}</span><span style="color:var(--text-muted)">${msg}</span>`;

  let alertasHTML='';
  if (qtAtraso>0) alertasHTML+=`<button class="status-alerta-pill atraso" onclick="irParaLancamentosEmAberto()">⚠ ${qtAtraso} título${qtAtraso>1?'s':''} em atraso · ${fmtBRL(vlAtraso)}</button>`;
  if (qtHoje>0) alertasHTML+=`<button class="status-alerta-pill hoje" onclick="irParaLancamentosEmAberto()">⏰ ${qtHoje} vence${qtHoje>1?'m':''} hoje</button>`;
  alertasEl.innerHTML=alertasHTML;
}
function irParaLancamentosEmAberto() {
  navigateTo('lancamentos');
  setTimeout(() => { $('filter-status').value='em_aberto'; loadTransactions(false); }, 200);
}

// Endpoint interno para status de caixa (busca local nos dados já carregados)
async function fetchContasStatus(filtro) {
  const txs = await api('/transactions?status=em_aberto');
  if (!Array.isArray(txs)) return [];
  const today = new Date(); today.setHours(0,0,0,0);
  return txs.filter(t => {
    if (!t.data_vencimento) return false;
    const v = new Date(t.data_vencimento+'T00:00:00'); v.setHours(0,0,0,0);
    if (filtro==='atrasado') return v < today;
    if (filtro==='hoje') return v.getTime()===today.getTime();
    return false;
  });
}

// ─── LANÇAMENTOS ──────────────────────────────────────────────────────────────
async function loadTransactions(reset) {
  if (reset) { $('filter-month').value=''; $('filter-type').value=''; $('filter-status').value=''; }
  const year=$('filter-year').value, month=$('filter-month').value, type=$('filter-type').value, status=$('filter-status').value;
  let url='/transactions';
  const qs=[];
  if(year) qs.push(`year=${year}`);
  if(month) qs.push(`month=${month}`);
  if(type) qs.push(`type=${type}`);
  if(status) qs.push(`status=${status}`);
  if(qs.length) url+='?'+qs.join('&');
  const txs = await api(url);
  state.transactions = Array.isArray(txs)?txs:[];
  renderTransactions(state.transactions);
}

$('btn-filter') && $('btn-filter').addEventListener('click', ()=>loadTransactions(false));

function renderTransactions(txs) {
  const tbody=document.querySelector('#tx-table tbody');
  if (!tbody) return;
  if (!txs.length) { tbody.innerHTML=`<tr><td colspan="12" style="text-align:center;padding:32px;color:var(--text-muted)">Nenhum lançamento encontrado</td></tr>`; return; }
  tbody.innerHTML=txs.map(t=>`<tr>
    <td>${t.date}</td>
    <td><span class="badge badge-${t.type==='income'?'income':'expense'}">${t.type==='income'?'Receita':'Despesa'}</span></td>
    <td>${esc(t.centro_custo)||'—'}</td>
    <td style="font-size:11.5px">${esc([t.grupo_contas,t.conta].filter(Boolean).join(' / '))||'—'}</td>
    <td>${esc(t.forma_pagamento)||'—'}</td>
    <td>${esc(t.caixa_banco)||'—'}</td>
    <td>${esc(t.cliente_fornecedor)||'—'}</td>
    <td style="font-weight:600;color:${t.type==='income'?'var(--green)':'var(--red)'}">${fmtBRL(t.amount)}</td>
    <td style="color:var(--red);font-size:11.5px">${t.taxa_mdr?fmtBRL(t.taxa_mdr):'—'}</td>
    <td style="font-weight:600">${fmtBRL(t.valor_liquido||t.amount)}</td>
    <td><span class="badge ${t.status==='quitado'?'badge-ok':'badge-pend'}">${t.status==='quitado'?'Quitado':'Em Aberto'}</span></td>
    <td>
      <button class="action-btn" onclick="editTx(${t.id})">✎</button>
      <button class="action-btn del" onclick="deleteTx(${t.id})">✕</button>
    </td>
  </tr>`).join('');
}

$('btn-new-tx') && $('btn-new-tx').addEventListener('click', ()=>openTxModal(null));

function openTxModal(tx) {
  $('modal-title').textContent = tx?'Editar Lançamento':'Novo Lançamento';
  $('tx-id').value=tx?tx.id:'';
  $('tx-type').value=tx?tx.type:'income';
  $('tx-date').value=tx?tx.date:new Date().toISOString().slice(0,10);
  updateContasByTipo(); // filtra centros, grupos e contas pelo tipo já definido
  setTimeout(()=>{
    // Restaura os valores selecionados DEPOIS de popular os selects
    $('tx-centro').value=tx?(tx.centro_custo||''):'';
    $('tx-grupo').value=tx?(tx.grupo_contas||''):'';
    $('tx-conta').value=tx?(tx.conta||''):'';
    $('tx-forma').value=tx?(tx.forma_pagamento||''):'';
    $('tx-caixa').value=tx?(tx.caixa_banco||''):'';
    $('tx-cliente').value=tx?(tx.cliente_fornecedor||''):'';
    $('tx-amount').value=tx?tx.amount:'';
    $('tx-status').value=tx?(tx.status||'quitado'):'quitado';
    $('tx-vencimento').value=tx?(tx.data_vencimento||''):'';
    $('tx-pagamento').value=tx?(tx.data_pagamento||''):'';
    $('tx-category').value=tx?(tx.category||''):'';
    $('tx-desc').value=tx?(tx.description||''):'';
    $('taxa-preview').classList.add('hidden');
  },10);
  $('modal-tx').classList.remove('hidden');
}

function editTx(id) { const tx=state.transactions.find(t=>t.id===id); if(tx) openTxModal(tx); }
async function deleteTx(id) {
  if (!confirm('Excluir este lançamento?')) return;
  await api(`/transactions/${id}`,'DELETE');
  loadTransactions(false);
}

$('btn-save-tx') && $('btn-save-tx').addEventListener('click', async () => {
  const id=$('tx-id').value;
  const body={
    date:$('tx-date').value, type:$('tx-type').value,
    category:$('tx-category').value||$('tx-centro').value||'Geral',
    grupo_contas:$('tx-grupo').value, conta:$('tx-conta').value,
    centro_custo:$('tx-centro').value, forma_pagamento:$('tx-forma').value,
    caixa_banco:$('tx-caixa').value, cliente_fornecedor:$('tx-cliente').value,
    description:$('tx-desc').value, amount:parseFloat($('tx-amount').value)||0,
    status:$('tx-status').value, data_vencimento:$('tx-vencimento').value||null,
    data_pagamento:$('tx-pagamento').value||null,
  };
  if (!body.date||!body.amount) { alert('Data e Valor são obrigatórios'); return; }
  const btn=$('btn-save-tx'); btn.textContent='Salvando...'; btn.disabled=true;
  const r = id ? await api(`/transactions/${id}`,'PUT',body) : await api('/transactions','POST',body);
  btn.textContent='Salvar'; btn.disabled=false;
  if (r.error) { alert('Erro: '+r.error); return; }
  $('modal-tx').classList.add('hidden');
  if(body.date) $('filter-year').value=body.date.slice(0,4);
  $('filter-month').value=''; $('filter-type').value=''; $('filter-status').value='';
  loadTransactions(false);
});

$('btn-cancel-tx') && $('btn-cancel-tx').addEventListener('click',()=>$('modal-tx').classList.add('hidden'));
$('modal-close') && $('modal-close').addEventListener('click',()=>$('modal-tx').classList.add('hidden'));
document.querySelector('#modal-tx .modal-backdrop') && document.querySelector('#modal-tx .modal-backdrop').addEventListener('click',()=>$('modal-tx').classList.add('hidden'));

// ─── TRANSFERÊNCIAS ───────────────────────────────────────────────────────────
// Não tem mais menu próprio — vive como uma sub-aba dentro de Lançamentos.
let _transfersCarregado = false;
function setLancSubtab(sub) {
  $('lanc-subtab-tx').classList.toggle('active', sub==='tx');
  $('lanc-subtab-tr').classList.toggle('active', sub==='tr');
  $('lanc-sub-tx').classList.toggle('hidden', sub!=='tx');
  $('lanc-sub-tr').classList.toggle('hidden', sub!=='tr');
  if (sub==='tr' && !_transfersCarregado) { _transfersCarregado = true; loadTransfers(true); }
}

async function loadTransfers(reset) {
  if(reset){$('tr-filter-month').value='';}
  const year=$('tr-filter-year').value, month=$('tr-filter-month').value;
  let url='/transfers'; const qs=[];
  if(year) qs.push(`year=${year}`);
  if(month) qs.push(`month=${month}`);
  if(qs.length) url+='?'+qs.join('&');
  const trs=await api(url);
  state.transfers=Array.isArray(trs)?trs:[];
  const tbody=document.querySelector('#tr-table tbody');
  if (!tbody) return;
  if (!state.transfers.length) { tbody.innerHTML=`<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">Nenhuma transferência encontrada</td></tr>`; return; }
  tbody.innerHTML=state.transfers.map(t=>`<tr>
    <td>${t.date}</td><td>${esc(t.caixa_saida)}</td><td>${esc(t.caixa_entrada)}</td>
    <td style="font-weight:600">${fmtBRL(t.amount)}</td><td>${esc(t.observacoes)||'—'}</td>
    <td><button class="action-btn del" onclick="deleteTr(${t.id})">✕</button></td>
  </tr>`).join('');
}

$('btn-filter-tr') && $('btn-filter-tr').addEventListener('click',()=>loadTransfers(false));
$('btn-new-tr') && $('btn-new-tr').addEventListener('click',()=>{
  $('tr-id').value=''; $('tr-date').value=new Date().toISOString().slice(0,10);
  $('tr-amount').value=''; $('tr-obs').value='';
  $('modal-tr').classList.remove('hidden');
});
$('btn-save-tr') && $('btn-save-tr').addEventListener('click', async()=>{
  const body={date:$('tr-date').value,caixa_saida:$('tr-saida').value,caixa_entrada:$('tr-entrada').value,amount:parseFloat($('tr-amount').value)||0,observacoes:$('tr-obs').value};
  if(!body.date||!body.caixa_saida||!body.caixa_entrada||!body.amount){alert('Preencha todos os campos');return;}
  await api('/transfers','POST',body);
  $('modal-tr').classList.add('hidden');
  loadTransfers(false);
});
async function deleteTr(id){if(!confirm('Excluir transferência?'))return;await api(`/transfers/${id}`,'DELETE');loadTransfers(false);}

// ─── DRE RESUMO ───────────────────────────────────────────────────────────────
async function loadDREResumo() {
  const year=$('resumo-year').value;
  const data=await api(`/dre/resumo?year=${year}`);
  const tbody=document.querySelector('#resumo-table tbody'); if(!tbody) return;
  tbody.innerHTML=data.summary.map(m=>{
    const lc=m.lucro, lc_cls=lc>0?'val-pos':lc<0?'val-neg':'val-0';
    return `<tr>
      <td>${m.mes}</td>
      <td>${fmtBRL(m.saldo_inicial)}</td>
      <td class="val-pos">${fmtBRL(m.receitas)}</td>
      <td class="val-neg">${fmtBRL(m.despesas)}</td>
      <td>${fmtBRL(m.total)}</td>
      <td class="${lc_cls}">${fmtBRL(lc)}</td>
      <td class="${lc_cls}">${fmtPct(m.lucratividade)}</td>
    </tr>`;
  }).join('');
  const t=data.totals;
  $('resumo-totals').innerHTML=`<td><strong>Total</strong></td><td>—</td><td class="val-pos"><strong>${fmtBRL(t.receitas)}</strong></td><td class="val-neg"><strong>${fmtBRL(t.despesas)}</strong></td><td>—</td><td class="${t.lucro>=0?'val-pos':'val-neg'}"><strong>${fmtBRL(t.lucro)}</strong></td><td class="${t.lucro>=0?'val-pos':'val-neg'}"><strong>${fmtPct(t.lucratividade)}</strong></td>`;
}
$('resumo-year') && $('resumo-year').addEventListener('change', loadDREResumo);
$('btn-export-pdf-resumo') && $('btn-export-pdf-resumo').addEventListener('click',()=>window.open(`/api/export/pdf?year=${($('resumo-year')||{value:new Date().getFullYear()}).value}`,'_blank'));

// ─── DRE DETALHADO ────────────────────────────────────────────────────────────
async function loadDREDetalhado() {
  const year=$('det-year').value;
  const data=await api(`/dre/detalhado?year=${year}`);
  const {meses,receitas,despesas,totReceita,totDespesa}=data;
  const thead=document.querySelector('#det-table thead'); if(!thead) return;
  const tbody=document.querySelector('#det-table tbody'); if(!tbody) return;
  thead.innerHTML=`<tr><th>Grupo / Conta</th>${meses.map(m=>`<th>${m}</th>`).join('')}<th>Total</th></tr>`;
  let rows='';
  if (receitas.length) {
    rows+=`<tr class="det-header-group"><td colspan="${meses.length+2}">▼ RECEITAS</td></tr>`;
    receitas.forEach(r=>{
      rows+=`<tr class="det-subtotal"><td style="padding-left:14px">${r.grupo} / ${r.conta}</td>${r.meses.map(v=>`<td class="${v>0?'val-pos':''}">${v?fmtBRL(v):'—'}</td>`).join('')}<td class="val-pos"><strong>${fmtBRL(r.total)}</strong></td></tr>`;
    });
    rows+=`<tr class="det-total-row"><td><strong>Total Receita</strong></td>${totReceita.map(v=>`<td class="val-pos">${fmtBRL(v)}</td>`).join('')}<td class="val-pos"><strong>${fmtBRL(totReceita.reduce((s,v)=>s+v,0))}</strong></td></tr>`;
  }
  if (despesas.length) {
    rows+=`<tr class="det-header-group"><td colspan="${meses.length+2}">▼ DESPESAS</td></tr>`;
    despesas.forEach(d=>{
      rows+=`<tr class="det-subtotal"><td style="padding-left:14px">${d.grupo} / ${d.conta}</td>${d.meses.map(v=>`<td class="${v>0?'val-neg':''}">${v?fmtBRL(v):'—'}</td>`).join('')}<td class="val-neg"><strong>${fmtBRL(d.total)}</strong></td></tr>`;
    });
    rows+=`<tr class="det-total-row"><td><strong>Total Despesa</strong></td>${totDespesa.map(v=>`<td class="val-neg">${fmtBRL(v)}</td>`).join('')}<td class="val-neg"><strong>${fmtBRL(totDespesa.reduce((s,v)=>s+v,0))}</strong></td></tr>`;
  }
  if (!rows) rows=`<tr><td colspan="${meses.length+2}" style="text-align:center;padding:32px;color:var(--text-muted)">Sem dados para este ano</td></tr>`;
  tbody.innerHTML=rows;
}
$('det-year') && $('det-year').addEventListener('change', loadDREDetalhado);
$('btn-export-excel-det') && $('btn-export-excel-det').addEventListener('click',()=>window.open(`/api/export/excel?year=${($('det-year')||{value:new Date().getFullYear()}).value}`,'_blank'));

// ─── FLUXO DE CAIXA ───────────────────────────────────────────────────────────
async function loadFluxoCaixa() {
  const year=$('fluxo-year').value||new Date().getFullYear();
  const month=$('fluxo-month').value;
  const caixa=$('fluxo-caixa').value;
  const data=await api(`/dre/fluxo-caixa?year=${year}&month=${month}&caixa=${encodeURIComponent(caixa)}`);
  if (!Array.isArray(data)) return;
  const totRec=data.reduce((s,d)=>s+d.receita,0);
  const totDesp=data.reduce((s,d)=>s+d.despesa,0);
  const totRes=totRec-totDesp;
  const saldoFinal=data.length?data[data.length-1].saldo:0;
  const saldoProjFinal=data.length?data[data.length-1].saldo_projetado:0;
  $('fluxo-rec').textContent=fmtBRL(totRec);
  $('fluxo-desp').textContent=fmtBRL(totDesp);
  $('fluxo-res').textContent=fmtBRL(totRes);
  $('fluxo-res').style.color=totRes>=0?'var(--green)':'var(--red)';
  $('fluxo-saldo').textContent=fmtBRL(saldoFinal);
  $('fluxo-saldo').style.color=saldoFinal>=0?'var(--green)':'var(--red)';
  if ($('fluxo-saldo-proj')) {
    $('fluxo-saldo-proj').textContent=fmtBRL(saldoProjFinal);
    $('fluxo-saldo-proj').style.color=saldoProjFinal>=0?'var(--green)':'var(--red)';
  }
  const tbody=document.querySelector('#fluxo-table tbody'); if(!tbody) return;
  tbody.innerHTML=data.map(d=>{
    const rc=d.resultado>0?'val-pos':d.resultado<0?'val-neg':'val-0';
    const sc=d.saldo>0?'val-pos':d.saldo<0?'val-neg':'val-0';
    const previsto=d.previsto||0;
    const pc=previsto>0?'val-pos':previsto<0?'val-neg':'val-0';
    const spc=d.saldo_projetado>0?'val-pos':d.saldo_projetado<0?'val-neg':'val-0';
    const semMovimento=!d.receita&&!d.despesa&&!d.transferencia&&!previsto;
    const row=`<tr ${semMovimento?'style="opacity:.45"':''}>
      <td>${d.data.slice(5).split('-').reverse().join('/')}</td>
      <td class="${d.receita?'val-pos':''}">${d.receita?fmtBRL(d.receita):'—'}</td>
      <td class="${d.despesa?'val-neg':''}">${d.despesa?fmtBRL(d.despesa):'—'}</td>
      <td>${d.transferencia?fmtBRL(d.transferencia):'—'}</td>
      <td class="${rc}">${fmtBRL(d.resultado)}</td>
      <td class="${sc}"><strong>${fmtBRL(d.saldo)}</strong></td>
      <td class="${pc}" style="font-size:11.5px">${previsto?fmtBRL(previsto):'—'}</td>
      <td class="${spc}" style="font-size:11.5px">${fmtBRL(d.saldo_projetado)}</td>
    </tr>`;
    return row;
  }).join('');
}
$('btn-filter-fluxo') && $('btn-filter-fluxo').addEventListener('click', loadFluxoCaixa);
$('fluxo-year') && $('fluxo-year').addEventListener('change', loadFluxoCaixa);
$('fluxo-month') && $('fluxo-month').addEventListener('change', loadFluxoCaixa);

// ─── CENTRO DE CUSTO ──────────────────────────────────────────────────────────
// ─── FORMAS DE PAGAMENTO REL ──────────────────────────────────────────────────
async function loadFormasPagamentoRel() {
  const year=$('fp-year').value;
  const data=await api(`/dre/formas-pagamento?year=${year}`);
  const {meses=[],formas=[]}=data;
  const thead=document.querySelector('#fp-table thead'); if(!thead) return;
  const tbody=document.querySelector('#fp-table tbody'); if(!tbody) return;
  thead.innerHTML=`<tr><th>Forma de Pagamento</th>${meses.map(m=>`<th>${m} Ent.</th><th>${m} Saí.</th>`).join('')}<th>Total Ent.</th><th>Total Saí.</th></tr>`;
  if (!formas.length) { tbody.innerHTML=`<tr><td colspan="${meses.length*2+3}" style="text-align:center;padding:32px;color:var(--text-muted)">Sem dados para este ano</td></tr>`; return; }
  tbody.innerHTML=formas.map(f=>`<tr>
    <td style="font-weight:500">${f.forma}</td>
    ${f.meses.map(m=>`<td class="${m.entradas?'val-pos':''}">${m.entradas?fmtBRL(m.entradas):'—'}</td><td class="${m.saidas?'val-neg':''}">${m.saidas?fmtBRL(m.saidas):'—'}</td>`).join('')}
    <td class="val-pos"><strong>${fmtBRL(f.total_entradas)}</strong></td>
    <td class="val-neg"><strong>${fmtBRL(f.total_saidas)}</strong></td>
  </tr>`).join('');
}
$('fp-year') && $('fp-year').addEventListener('change', loadFormasPagamentoRel);

// ─── CADASTROS ────────────────────────────────────────────────────────────────
const cadConfig = {
  clientes: {
    title:'Cliente',
    fields:[{k:'nome',l:'Nome *',type:'text'},{k:'cnpj_cpf',l:'CNPJ/CPF',type:'text'},{k:'estado',l:'Estado',type:'text'},{k:'cidade',l:'Cidade',type:'text'},{k:'telefone',l:'Telefone',type:'text'},{k:'email',l:'E-mail',type:'email'},{k:'observacoes',l:'Observações',type:'text',span:true}],
    table:(items)=>items.map(i=>`<tr><td>${esc(i.nome)}</td><td>${esc(i.cnpj_cpf)||'—'}</td><td>${esc(i.cidade)||'—'}</td><td>${esc(i.estado)||'—'}</td><td>${esc(i.telefone)||'—'}</td><td>${esc(i.email)||'—'}</td><td><button class="action-btn" onclick="editCad('clientes',${i.id})">✎</button><button class="action-btn del" onclick="delCad('clientes',${i.id})">✕</button></td></tr>`).join(''),
  },
  fornecedores: {
    title:'Fornecedor',
    fields:[{k:'nome',l:'Nome *',type:'text'},{k:'cnpj_cpf',l:'CNPJ/CPF',type:'text'},{k:'estado',l:'Estado',type:'text'},{k:'cidade',l:'Cidade',type:'text'},{k:'telefone',l:'Telefone',type:'text'},{k:'email',l:'E-mail',type:'email'},{k:'observacoes',l:'Observações',type:'text',span:true}],
    table:(items)=>items.map(i=>`<tr><td>${esc(i.nome)}</td><td>${esc(i.cnpj_cpf)||'—'}</td><td>${esc(i.cidade)||'—'}</td><td>${esc(i.estado)||'—'}</td><td>${esc(i.telefone)||'—'}</td><td>${esc(i.email)||'—'}</td><td><button class="action-btn" onclick="editCad('fornecedores',${i.id})">✎</button><button class="action-btn del" onclick="delCad('fornecedores',${i.id})">✕</button></td></tr>`).join(''),
  },
  caixas: {
    title:'Caixa / Banco',
    fields:[{k:'nome',l:'Nome *',type:'text'},{k:'saldo_inicial',l:'Saldo Inicial (R$)',type:'number'}],
    table:(items)=>items.map(i=>`<tr><td>${esc(i.nome)}</td><td>${fmtBRL(i.saldo_inicial||0)}</td><td><button class="action-btn" onclick="editCad('caixas',${i.id})">✎</button><button class="action-btn del" onclick="delCad('caixas',${i.id})">✕</button></td></tr>`).join(''),
  },
  formas_pagamento: {
    title:'Forma de Pagamento',
    fields:[{k:'nome',l:'Nome *',type:'text'},{k:'banco',l:'Banco',type:'text'},{k:'agencia',l:'Agência',type:'text'},{k:'parcelas',l:'Parcelas',type:'number'},{k:'dias_recebimento',l:'Dias para Recebimento',type:'number'},{k:'taxa_intermediacao',l:'Taxa Intermediação %',type:'number'},{k:'taxa_parcelamento',l:'Taxa Parcelamento %',type:'number'},{k:'tarifa_fixa',l:'Tarifa Fixa R$',type:'number'}],
    table:(items)=>items.map(i=>`<tr><td>${esc(i.nome)}</td><td>${esc(i.banco)||'—'}</td><td>${esc(i.agencia)||'—'}</td><td>${i.parcelas||1}x</td><td>${i.dias_recebimento||0}d</td><td>${i.taxa_intermediacao||0}%</td><td>${i.taxa_parcelamento||0}%</td><td>${fmtBRL(i.tarifa_fixa||0)}</td><td><button class="action-btn" onclick="editCad('formas_pagamento',${i.id})">✎</button><button class="action-btn del" onclick="delCad('formas_pagamento',${i.id})">✕</button></td></tr>`).join(''),
  },
};

let currentCadTable='', currentCadId=null, currentCadItems=[];

async function loadCad(table) {
  currentCadTable=table;
  const items=await api(`/${table}`);
  currentCadItems=Array.isArray(items)?items:[];
  const conf=cadConfig[table]; if(!conf) return;
  const tid=`cad-${table.replace('_','-')}-table`;
  const tbodyEl=document.querySelector(`#${tid} tbody`);
  if (!tbodyEl) return;
  if (!currentCadItems.length) { tbodyEl.innerHTML=`<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted)">Nenhum cadastro encontrado</td></tr>`; return; }
  tbodyEl.innerHTML=conf.table(currentCadItems);
  // update full formas for taxa calc
  if (table==='formas_pagamento') state.cadastros._formasFull=currentCadItems;
}

function openCadModal(table, id=null) {
  currentCadTable=table; currentCadId=id;
  const conf=cadConfig[table]; if(!conf) return;
  const item=id?currentCadItems.find(i=>i.id===id):null;
  $('cad-modal-title').textContent=(id?'Editar ':'Novo ')+conf.title;
  $('cad-modal-body').innerHTML=conf.fields.map(f=>`
    <div class="field ${f.span?'span2':''}">
      <label>${f.l}</label>
      <input type="${f.type}" id="cad-field-${f.k}" value="${item?item[f.k]||'':''}" placeholder="${f.l.replace(' *','')}"/>
    </div>`).join('');
  $('modal-cad').classList.remove('hidden');
}

function editCad(table, id) { currentCadTable=table; const items=currentCadItems; openCadModal(table, id); }
async function delCad(table, id) {
  if (!confirm('Excluir este cadastro?')) return;
  await api(`/${table}/${id}`,'DELETE');
  loadCad(table); loadCadastros();
}

$('btn-save-cad') && $('btn-save-cad').addEventListener('click', async()=>{
  const conf=cadConfig[currentCadTable]; if(!conf) return;
  const body={};
  conf.fields.forEach(f=>{ const el=$(`cad-field-${f.k}`); if(el) body[f.k]=f.type==='number'?parseFloat(el.value)||0:el.value; });
  const r=currentCadId ? await api(`/${currentCadTable}/${currentCadId}`,'PUT',body) : await api(`/${currentCadTable}`,'POST',body);
  if(r.error){alert('Erro: '+r.error);return;}
  $('modal-cad').classList.add('hidden');
  await loadCad(currentCadTable);
  await loadCadastros();
});

// ─── CADASTROS: PARCEIROS (com anexos) ───────────────────────────────────────
let currentParceiroId = null, currentParceiros = [];

// Máscaras simples (sem libs externas): formatam enquanto o usuário digita e
// limitam a quantidade de dígitos aceitos.
function maskCNPJ(v) {
  v = v.replace(/\D/g, '').slice(0, 14);
  if (v.length <= 2)  return v;
  if (v.length <= 5)  return `${v.slice(0,2)}.${v.slice(2)}`;
  if (v.length <= 8)  return `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5)}`;
  if (v.length <= 12) return `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5,8)}/${v.slice(8)}`;
  return `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5,8)}/${v.slice(8,12)}-${v.slice(12)}`;
}
function maskTelefone(v) {
  v = v.replace(/\D/g, '').slice(0, 11);
  if (!v) return '';
  if (v.length <= 2)  return `(${v}`;
  if (v.length <= 6)  return `(${v.slice(0,2)}) ${v.slice(2)}`;
  if (v.length <= 10) return `(${v.slice(0,2)}) ${v.slice(2,6)}-${v.slice(6)}`;
  return `(${v.slice(0,2)}) ${v.slice(2,7)}-${v.slice(7)}`;
}
['parc-cnpj'].forEach(id => $(id) && $(id).addEventListener('input', e => { e.target.value = maskCNPJ(e.target.value); }));
['parc-contato','parc-whatsapp'].forEach(id => $(id) && $(id).addEventListener('input', e => { e.target.value = maskTelefone(e.target.value); }));
$('parc-comissao') && $('parc-comissao').addEventListener('blur', e => {
  if (e.target.value === '') return;
  let v = parseFloat(e.target.value);
  if (isNaN(v)) { e.target.value = ''; return; }
  v = Math.max(0, v);
  e.target.value = v.toFixed(2);
});

// Renderiza a pré-visualização (imagem, se for arquivo de imagem, ou ícone de
// documento) tanto pro arquivo recém-selecionado quanto pro já salvo no servidor.
function renderAnexoPreview(kind, file, existingPath) {
  const wrap = $(`parc-${kind}-preview`);
  if (!wrap) return;
  let url = null, isImage = false;
  if (file) {
    url = URL.createObjectURL(file);
    isImage = file.type.startsWith('image/');
  } else if (existingPath) {
    url = existingPath;
    isImage = /\.(png|jpe?g|gif|webp)$/i.test(existingPath);
  }
  if (!url) { wrap.innerHTML = ''; wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  wrap.innerHTML = isImage
    ? `<img src="${url}" class="file-preview-img" alt="pré-visualização"/>`
    : `<div class="file-preview-doc">📄</div>`;
}

async function loadParceiros() {
  const items = await api('/parceiros');
  currentParceiros = Array.isArray(items) ? items : [];
  const tbody = document.querySelector('#cad-parceiros-table tbody');
  if (!tbody) return;
  if (!currentParceiros.length) { tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-muted)">Nenhum parceiro cadastrado</td></tr>`; return; }
  tbody.innerHTML = currentParceiros.map(p => `
    <tr>
      <td>${esc(p.nome)}</td>
      <td>${esc(p.razao_social)}</td>
      <td>${esc(p.cnpj)}</td>
      <td>${esc(p.responsavel)}</td>
      <td>${esc(p.contato)}</td>
      <td>${esc(p.whatsapp)||'—'}</td>
      <td>${p.comissao ? fmtBRL(p.comissao) : '—'}</td>
      <td>${p.foto_path?`<a href="${p.foto_path}" target="_blank" class="anexo-thumb" title="Ver foto"><img src="${p.foto_path}" alt="foto"/></a>`:''}${p.contrato_path?`<a href="${p.contrato_path}" target="_blank" class="anexo-doc-link" title="Ver contrato">📎</a>`:''}${(!p.foto_path&&!p.contrato_path)?'—':''}</td>
      <td><button class="action-btn" onclick="editParceiro(${p.id})">✎</button><button class="action-btn del" onclick="delParceiro(${p.id})">✕</button></td>
    </tr>`).join('');
}

function openParceiroModal(id=null) {
  currentParceiroId = id;
  const item = id ? currentParceiros.find(p => p.id === id) : null;
  $('parceiro-modal-title').textContent = id ? 'Editar Parceiro' : 'Novo Parceiro';
  $('parceiro-modal-error').textContent = '';
  $('parc-nome').value         = item ? item.nome || ''         : '';
  $('parc-razao-social').value = item ? item.razao_social || '' : '';
  $('parc-cnpj').value         = item ? maskCNPJ(item.cnpj || '')          : '';
  $('parc-email').value        = item ? item.email || ''        : '';
  $('parc-endereco').value     = item ? item.endereco || ''     : '';
  $('parc-comissao').value     = item ? item.comissao || ''     : '';
  $('parc-contato').value      = item ? maskTelefone(item.contato || '')   : '';
  $('parc-whatsapp').value     = item ? maskTelefone(item.whatsapp || '')  : '';
  $('parc-responsavel').value  = item ? item.responsavel || ''  : '';
  $('parc-foto-input').value = '';
  $('parc-contrato-input').value = '';
  $('parc-foto-name').textContent     = item && item.foto_nome     ? item.foto_nome     : 'Nenhum arquivo';
  $('parc-contrato-name').textContent = item && item.contrato_nome ? item.contrato_nome : 'Nenhum arquivo';
  renderAnexoPreview('foto', null, item ? item.foto_path : null);
  renderAnexoPreview('contrato', null, item ? item.contrato_path : null);
  $('modal-parceiro').classList.remove('hidden');
}

function editParceiro(id) { openParceiroModal(id); }

async function delParceiro(id) {
  if (!confirm('Excluir este parceiro?')) return;
  await api(`/parceiros/${id}`, 'DELETE');
  loadParceiros();
}

$('parc-foto-input') && $('parc-foto-input').addEventListener('change', () => {
  const f = $('parc-foto-input').files[0];
  $('parc-foto-name').textContent = f ? f.name : 'Nenhum arquivo';
  renderAnexoPreview('foto', f || null, f ? null : (currentParceiroId ? (currentParceiros.find(p=>p.id===currentParceiroId)||{}).foto_path : null));
});
$('parc-contrato-input') && $('parc-contrato-input').addEventListener('change', () => {
  const f = $('parc-contrato-input').files[0];
  $('parc-contrato-name').textContent = f ? f.name : 'Nenhum arquivo';
  renderAnexoPreview('contrato', f || null, f ? null : (currentParceiroId ? (currentParceiros.find(p=>p.id===currentParceiroId)||{}).contrato_path : null));
});

// Anexos exigem multipart/form-data — não dá pra usar o helper api() (que só
// manda JSON), então esse envio vai direto por fetch com FormData.
$('btn-save-parceiro') && $('btn-save-parceiro').addEventListener('click', async () => {
  const nome        = $('parc-nome').value.trim();
  const razaoSocial = $('parc-razao-social').value.trim();
  const cnpj        = $('parc-cnpj').value.trim();
  const responsavel = $('parc-responsavel').value.trim();
  const contato     = $('parc-contato').value.trim();
  if (!nome || !razaoSocial || !cnpj || !responsavel || !contato) {
    $('parceiro-modal-error').textContent = 'Preencha os campos obrigatórios: Nome, Razão Social, CNPJ, Responsável e Contato.';
    return;
  }
  let comissao = $('parc-comissao').value;
  comissao = comissao === '' ? 0 : Math.max(0, parseFloat(comissao) || 0);
  const fd = new FormData();
  fd.append('nome', nome);
  fd.append('razao_social', razaoSocial);
  fd.append('cnpj', cnpj);
  fd.append('email', $('parc-email').value.trim());
  fd.append('endereco', $('parc-endereco').value.trim());
  fd.append('comissao', comissao);
  fd.append('contato', contato);
  fd.append('whatsapp', $('parc-whatsapp').value.trim());
  fd.append('responsavel', responsavel);
  const fotoFile     = $('parc-foto-input').files[0];
  const contratoFile = $('parc-contrato-input').files[0];
  if (fotoFile)     fd.append('foto', fotoFile);
  if (contratoFile) fd.append('contrato', contratoFile);

  try {
    const url    = currentParceiroId ? `/api/parceiros/${currentParceiroId}` : '/api/parceiros';
    const method = currentParceiroId ? 'PUT' : 'POST';
    const res    = await fetch(url, { method, credentials: 'include', body: fd });
    const data   = await res.json().catch(() => ({}));
    if (res.status === 401) { showAuth(); return; }
    if (data.error) { $('parceiro-modal-error').textContent = 'Erro: ' + data.error; return; }
    $('modal-parceiro').classList.add('hidden');
    loadParceiros();
  } catch (e) {
    $('parceiro-modal-error').textContent = 'Erro ao salvar parceiro.';
  }
});

// ─── DOCUMENTOS (Importar/Exportar) ────────────────────────────────────────────
// Substitui a antiga importação de planilha: 3 tipos de documento, cada um
// podendo vincular a um parceiro ou fornecedor já cadastrado.
const DOC_TIPOS = {
  contrato_parceiro:   { label: 'Contrato de Parceiro',   vinculo: 'parceiro' },
  nota_fiscal:         { label: 'Nota Fiscal',            vinculo: null },
  contrato_fornecedor: { label: 'Contrato de Fornecedor', vinculo: 'fornecedor' },
};
let currentDocTipo = 'contrato_parceiro';

async function setDocSubtab(tipo) {
  currentDocTipo = tipo;
  Object.keys(DOC_TIPOS).forEach(t => $(`doc-subtab-${t}`) && $(`doc-subtab-${t}`).classList.toggle('active', t===tipo));
  $('doc-panel-title').textContent = DOC_TIPOS[tipo].label;
  $('doc-file-input').value = '';
  $('doc-file-name').textContent = 'Nenhum arquivo';
  $('doc-descricao').value = '';
  $('doc-upload-error').textContent = '';

  const vinculo = DOC_TIPOS[tipo].vinculo;
  if (!vinculo) {
    $('doc-vinculo-wrap').classList.add('hidden');
  } else {
    $('doc-vinculo-wrap').classList.remove('hidden');
    $('doc-vinculo-label').textContent = vinculo === 'parceiro' ? 'Parceiro' : 'Fornecedor';
    const items = vinculo === 'parceiro' ? await api('/parceiros') : await api('/fornecedores');
    const opts = (Array.isArray(items)?items:[]).map(i => `<option value="${i.id}">${esc(i.nome)}</option>`).join('');
    $('doc-vinculo').innerHTML = `<option value="">Selecione...</option>${opts}`;
  }
  loadDocumentos(tipo);
}

async function loadDocumentos(tipo) {
  const docs = await api(`/documentos?tipo=${tipo}`);
  const el = $('documentos-list');
  const lista = Array.isArray(docs) ? docs : [];
  if (!lista.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:12px">Nenhum documento enviado ainda</p>'; return; }
  el.innerHTML = lista.map(d => `<div class="import-item">
    <div><div class="fname">📄 ${esc(d.descricao) || esc(d.parceiro_nome) || esc(d.fornecedor_nome) || esc(d.arquivo_nome)}</div>
      <div class="fdate">${esc(d.parceiro_nome||d.fornecedor_nome||'')}${(d.parceiro_nome||d.fornecedor_nome)?' · ':''}${new Date(d.created_at).toLocaleString('pt-BR')}</div></div>
    <div style="display:flex;gap:6px">
      <a class="btn-outline" style="font-size:11px;padding:4px 10px;text-decoration:none" href="${d.arquivo_path}" target="_blank">Ver</a>
      <button class="btn-outline" style="font-size:11px;padding:4px 10px;color:var(--red);border-color:var(--red)" onclick="deleteDocumento(${d.id})">Excluir</button>
    </div>
  </div>`).join('');
}

async function deleteDocumento(id) {
  if (!confirm('Excluir este documento?')) return;
  await api(`/documentos/${id}`, 'DELETE');
  loadDocumentos(currentDocTipo);
}

$('doc-file-input') && $('doc-file-input').addEventListener('change', () => {
  const f = $('doc-file-input').files[0];
  $('doc-file-name').textContent = f ? f.name : 'Nenhum arquivo';
});

// Upload precisa de multipart/form-data — não dá pra usar o helper api() (que
// só manda JSON) — mesmo padrão usado nos anexos de Parceiros e no Perfil.
$('btn-upload-doc') && $('btn-upload-doc').addEventListener('click', async () => {
  const file = $('doc-file-input').files[0];
  if (!file) { $('doc-upload-error').textContent = 'Selecione um arquivo.'; return; }
  const vinculo = DOC_TIPOS[currentDocTipo].vinculo;
  if (vinculo && !$('doc-vinculo').value) {
    $('doc-upload-error').textContent = `Selecione o ${vinculo === 'parceiro' ? 'parceiro' : 'fornecedor'}.`;
    return;
  }
  const fd = new FormData();
  fd.append('tipo', currentDocTipo);
  fd.append('descricao', $('doc-descricao').value.trim());
  if (vinculo === 'parceiro')   fd.append('parceiro_id', $('doc-vinculo').value);
  if (vinculo === 'fornecedor') fd.append('fornecedor_id', $('doc-vinculo').value);
  fd.append('arquivo', file);

  try {
    const res  = await fetch('/api/documentos', { method: 'POST', credentials: 'include', body: fd });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showAuth(); return; }
    if (data.error) { $('doc-upload-error').textContent = 'Erro: ' + data.error; return; }
    $('doc-file-input').value = ''; $('doc-file-name').textContent = 'Nenhum arquivo'; $('doc-descricao').value = '';
    loadDocumentos(currentDocTipo);
  } catch (e) {
    $('doc-upload-error').textContent = 'Erro ao enviar documento.';
  }
});

document.querySelectorAll('.export-btn').forEach(btn=>btn.addEventListener('click',()=>{
  window.open(`/api/export/${btn.dataset.fmt}?year=${$('export-year').value}`,'_blank');
}));

// ─── USERS ────────────────────────────────────────────────────────────────────
let currentEditUserId = null, usersCache = [];

async function loadUsers(){
  const users=await api('/users');
  usersCache = Array.isArray(users) ? users : [];
  const utbody=document.querySelector('#users-table tbody'); if(!utbody) return; utbody.innerHTML=usersCache.map(u=>`<tr>
    <td>${u.id}</td><td>${esc(u.username)}</td>
    <td><span class="badge ${u.role==='admin'?'badge-admin':'badge-pend'}">${u.role==='admin'?'Admin':'Usuário'}</span></td>
    <td>${new Date(u.created_at).toLocaleDateString('pt-BR')}</td>
    <td>${u.id!==state.user.id?`<button class="action-btn" onclick="openEditUser(${u.id})" title="Editar">✎</button><button class="action-btn" onclick="toggleRole(${u.id},'${u.role}')" title="${u.role==='admin'?'Rebaixar':'Promover'}">${u.role==='admin'?'↓':'↑'}</button><button class="action-btn del" onclick="deleteUser(${u.id})">✕</button>`:'<span style="color:var(--text-muted);font-size:11px">(você)</span>'}</td>
  </tr>`).join('');
}
async function toggleRole(id,role){if(!confirm(`Alterar para "${role==='admin'?'user':'admin'}"?`))return;await api(`/users/${id}/role`,'PUT',{role:role==='admin'?'user':'admin'});loadUsers();}
async function deleteUser(id){if(!confirm('Excluir usuário?'))return;await api(`/users/${id}`,'DELETE');loadUsers();}

function openUserModal(){
  currentEditUserId = null;
  $('cad-usuario-title').textContent = 'Novo Usuário';
  $('user-field-password-label').textContent = 'Senha';
  $('user-field-password').placeholder = 'senha (mín. 4 caracteres)';
  $('btn-save-user').textContent = 'Criar usuário';
  $('user-field-username').value=''; $('user-field-password').value=''; $('user-field-role').value='user';
  $('user-modal-error').textContent='';
  renderPermissoesCheckboxes([]);
  $('user-permissoes-wrap').classList.remove('hidden');
  navigateTo('cad-usuario');
}
function openEditUser(id) {
  const u = usersCache.find(x => x.id === id);
  if (!u) return;
  currentEditUserId = id;
  $('cad-usuario-title').textContent = `Editar Usuário`;
  $('user-field-password-label').textContent = 'Nova Senha';
  $('user-field-password').placeholder = 'deixe em branco para não alterar';
  $('btn-save-user').textContent = 'Salvar alterações';
  $('user-field-username').value = u.username;
  $('user-field-password').value = '';
  $('user-field-role').value = u.role;
  $('user-modal-error').textContent = '';
  renderPermissoesCheckboxes(u.permissoes || []);
  $('user-permissoes-wrap').classList.toggle('hidden', u.role === 'admin');
  navigateTo('cad-usuario');
}
$('btn-new-user') && $('btn-new-user').addEventListener('click', openUserModal);
$('btn-cancel-user') && $('btn-cancel-user').addEventListener('click', () => navigateTo('users'));

// Renderiza os checkboxes de telas permitidas (usado ao abrir a tela de novo/editar usuário).
function renderPermissoesCheckboxes(selecionadas = []) {
  const wrap = $('user-permissoes-list');
  if (!wrap) return;
  wrap.innerHTML = PAGINAS_PERMISSAO.map(p => `
    <label class="perm-item">
      <input type="checkbox" value="${p.key}" ${selecionadas.includes(p.key) ? 'checked' : ''}/>
      ${esc(p.label)}
    </label>`).join('');
}
function getPermissoesSelecionadas() {
  return Array.from(document.querySelectorAll('#user-permissoes-list input[type=checkbox]:checked')).map(i => i.value);
}
// Admin tem acesso total por natureza — some com a lista de telas nesse caso.
$('user-field-role') && $('user-field-role').addEventListener('change', () => {
  $('user-permissoes-wrap').classList.toggle('hidden', $('user-field-role').value === 'admin');
});

$('btn-save-user') && $('btn-save-user').addEventListener('click', async()=>{
  const body={
    username: $('user-field-username').value.trim(),
    password: $('user-field-password').value,
    role: $('user-field-role').value,
  };
  if (body.role !== 'admin') body.permissoes = getPermissoesSelecionadas();

  if (currentEditUserId) {
    if(!body.username){ $('user-modal-error').textContent='Preencha o usuário.'; return; }
    const r=await api(`/users/${currentEditUserId}`,'PUT',body);
    if(r.error){ $('user-modal-error').textContent=r.error; return; }
  } else {
    if(!body.username || !body.password){ $('user-modal-error').textContent='Preencha usuário e senha.'; return; }
    const r=await api('/users','POST',body);
    if(r.error){ $('user-modal-error').textContent=r.error; return; }
  }
  navigateTo('users');
  loadUsers();
});

// ─── LOGS ─────────────────────────────────────────────────────────────────────
const ACTION_LABELS = {
  login:'Login', login_failed:'Login falhou', logout:'Logout', create:'Criação',
  update:'Edição', delete:'Exclusão', baixa:'Baixa de título', update_status:'Alteração de status',
  update_role:'Alteração de função', setup_admin:'Config. inicial',
};
const ENTITY_LABELS = {
  auth:'Autenticação', users:'Usuários', transactions:'Lançamento', transfers:'Transferência',
  clientes:'Cliente', fornecedores:'Fornecedor', caixas:'Caixa/Banco', formas_pagamento:'Forma de Pagamento',
  contas_receita:'Conta de Receita', contas_despesa:'Conta de Despesa', centros_custo:'Centro de Custo',
};
let currentLogPage = 1;

function fmtLogDate(v){
  if(!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleString('pt-BR');
}

async function loadLogs(page=1){
  currentLogPage = page;
  const qs = [`page=${page}`, `limit=50`];
  const action = $('log-action') && $('log-action').value;
  const username = $('log-username') && $('log-username').value.trim();
  const from = $('log-from') && $('log-from').value;
  const to = $('log-to') && $('log-to').value;
  if (action) qs.push(`action=${encodeURIComponent(action)}`);
  if (username) qs.push(`username=${encodeURIComponent(username)}`);
  if (from) qs.push(`from=${encodeURIComponent(from)}`);
  if (to) qs.push(`to=${encodeURIComponent(to)}`);

  const r = await api(`/logs?${qs.join('&')}`);
  const rows = (r && Array.isArray(r.rows)) ? r.rows : [];
  const tbody = document.querySelector('#logs-table tbody');
  if (tbody) {
    tbody.innerHTML = rows.length ? rows.map(l => `<tr>
      <td style="white-space:nowrap">${fmtLogDate(l.created_at)}</td>
      <td>${esc(l.username)||'—'}</td>
      <td><span class="badge badge-log-${esc(l.action)}">${esc(ACTION_LABELS[l.action]||l.action)}</span></td>
      <td>${esc(ENTITY_LABELS[l.entity]||l.entity)}${l.entity_id?` #${l.entity_id}`:''}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.details)||''}">${esc(l.details)||'—'}</td>
      <td style="font-size:11px;color:var(--text-muted)">${esc(l.ip)||'—'}</td>
    </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">Nenhum log encontrado</td></tr>`;
  }
  if ($('log-page-info')) $('log-page-info').textContent = `Página ${r.page||1} de ${r.pages||1} (${r.total||0} registros)`;
  if ($('btn-log-prev')) $('btn-log-prev').disabled = (r.page||1) <= 1;
  if ($('btn-log-next')) $('btn-log-next').disabled = (r.page||1) >= (r.pages||1);
}
$('btn-log-filter') && $('btn-log-filter').addEventListener('click', ()=>loadLogs(1));
$('btn-log-prev') && $('btn-log-prev').addEventListener('click', ()=>{ if(currentLogPage>1) loadLogs(currentLogPage-1); });
$('btn-log-next') && $('btn-log-next').addEventListener('click', ()=>loadLogs(currentLogPage+1));

// ─── GLOBALS ──────────────────────────────────────────────────────────────────
window.editTx=editTx; window.deleteTx=deleteTx;
window.deleteTr=deleteTr;
window.toggleRole=toggleRole; window.deleteUser=deleteUser; window.openEditUser=openEditUser;
window.openCadModal=openCadModal; window.editCad=editCad; window.delCad=delCad;
window.openParceiroModal=openParceiroModal; window.editParceiro=editParceiro; window.delParceiro=delParceiro;
window.navigateTo=navigateTo; window.setLancSubtab=setLancSubtab; window.irParaLancamentosEmAberto=irParaLancamentosEmAberto;
window.setDocSubtab=setDocSubtab; window.deleteDocumento=deleteDocumento;

checkAuth();


}); // end DOMContentLoaded
