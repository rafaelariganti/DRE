const express      = require('express');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const multer       = require('multer');
const XLSX         = require('xlsx');
const PDFDocument  = require('pdfkit');
const cookieParser = require('cookie-parser');
const path         = require('path');
const { initDb, migrarLegado, getPool } = require('./database');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dre_oaf_2026_secret_key';
const upload     = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── HELPERS ───────────────────────────────────────────────────────────────────
function db() { return getPool(); }

async function q(sql, params = []) {
  const [rows] = await db().query(sql, params);
  return rows;
}
async function q1(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0] || null;
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.cookies.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito' });
  next();
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
// Cadastro público só existe para o "bootstrap" do sistema (primeiro admin, quando
// ainda não há nenhum usuário no banco). Depois disso, novos usuários só podem ser
// criados por um admin já autenticado, de dentro do painel (ver POST /api/users).
app.post('/api/auth/register', async (req, res) => {
  try {
    const [{ n }] = await q('SELECT COUNT(*) as n FROM users');
    if (n > 0) return res.status(403).json({ error: 'Cadastro público desativado. Peça a um administrador para criar seu acesso.' });
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Campos obrigatórios' });
    const hash = await bcrypt.hash(password, 10);
    const result = await q('INSERT INTO users (username, password, role) VALUES (?,?,?)', [username, hash, 'admin']);
    const id = result.insertId;
    const role = 'admin';
    const token = jwt.sign({ id, username, role }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
    res.json({ id, username, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sinaliza pro front se o sistema já tem algum usuário (controla o link "Configurar acesso inicial").
app.get('/api/auth/setup-status', async (req, res) => {
  try {
    const [{ n }] = await q('SELECT COUNT(*) as n FROM users');
    res.json({ needsSetup: n === 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await q1('SELECT * FROM users WHERE username=?', [username]);
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(401).json({ error: 'Credenciais inválidas' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
    res.json({ id: user.id, username: user.username, role: user.role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
app.get('/api/auth/me', auth, (req, res) => res.json(req.user));

// ── TRANSACTIONS ──────────────────────────────────────────────────────────────
app.get('/api/transactions', auth, async (req, res) => {
  try {
    const { month, year, type, status, centro_custo, forma_pagamento, caixa_banco } = req.query;
    let sql = 'SELECT * FROM transactions WHERE 1=1';
    const p = [];
    if (year)            { sql += ' AND YEAR(data)=?';               p.push(year); }
    if (month)           { sql += ' AND MONTH(data)=?';              p.push(month); }
    if (type)            { sql += ' AND tipo=?';                     p.push(type); }
    if (status)          { sql += ' AND status=?';                   p.push(status); }
    if (centro_custo)    { sql += ' AND centro_custo_nome=?';        p.push(centro_custo); }
    if (forma_pagamento) { sql += ' AND forma_pagamento_nome=?';     p.push(forma_pagamento); }
    if (caixa_banco)     { sql += ' AND caixa_nome=?';               p.push(caixa_banco); }
    sql += ' ORDER BY data DESC, id DESC';
    const rows = await q(sql, p);
    // Normaliza campos para o front-end (mantém compatibilidade)
    res.json(rows.map(normalizeTransaction));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/transactions', auth, async (req, res) => {
  try {
    const b = req.body;
    if (!b.date && !b.data) return res.status(400).json({ error: 'Campo obrigatório: date' });
    if (!b.type && !b.tipo) return res.status(400).json({ error: 'Campo obrigatório: type' });
    if (b.amount == null && b.valor == null) return res.status(400).json({ error: 'Campo obrigatório: amount' });

    const tipo  = b.type  || b.tipo;
    const data  = b.date  || b.data;
    const valor = Number(b.amount || b.valor || 0);
    const taxa  = await calcTaxaMDR(b.forma_pagamento || b.forma_pagamento_nome, valor);

    const result = await q(`
      INSERT INTO transactions
        (tipo, data, descricao, valor, conta_nome, grupo, cliente_fornecedor,
         forma_pagamento_nome, caixa_nome, centro_custo_nome, status,
         data_vencimento, data_pagamento, taxa_mdr, valor_liquido, observacoes, user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tipo, data, b.description || b.descricao || '',
       valor,
       b.conta || b.conta_nome || '',
       b.grupo_contas || b.grupo || '',
       b.cliente_fornecedor || '',
       b.forma_pagamento || b.forma_pagamento_nome || '',
       b.caixa_banco || b.caixa_nome || '',
       b.centro_custo || b.centro_custo_nome || '',
       b.status || 'realizado',
       b.data_vencimento || null,
       b.data_pagamento  || null,
       taxa, valor - taxa,
       b.observacoes || '',
       req.user.id]
    );
    res.json({ id: result.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/transactions/:id', auth, async (req, res) => {
  try {
    const b    = req.body;
    const id   = Number(req.params.id);
    const valor = Number(b.amount || b.valor || 0);
    const taxa  = await calcTaxaMDR(b.forma_pagamento || b.forma_pagamento_nome, valor);
    await q(`
      UPDATE transactions SET
        tipo=?, data=?, descricao=?, valor=?, conta_nome=?, grupo=?,
        cliente_fornecedor=?, forma_pagamento_nome=?, caixa_nome=?,
        centro_custo_nome=?, status=?, data_vencimento=?, data_pagamento=?,
        taxa_mdr=?, valor_liquido=?, observacoes=?
      WHERE id=?`,
      [b.type || b.tipo,
       b.date || b.data,
       b.description || b.descricao || '',
       valor,
       b.conta || b.conta_nome || '',
       b.grupo_contas || b.grupo || '',
       b.cliente_fornecedor || '',
       b.forma_pagamento || b.forma_pagamento_nome || '',
       b.caixa_banco || b.caixa_nome || '',
       b.centro_custo || b.centro_custo_nome || '',
       b.status || 'realizado',
       b.data_vencimento || null,
       b.data_pagamento  || null,
       taxa, valor - taxa,
       b.observacoes || '',
       id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH: atualização parcial de status/baixa (RF06)
app.patch('/api/transactions/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b  = req.body;
    const fields = [], vals = [];
    if (b.status !== undefined)        { fields.push('status=?');          vals.push(b.status); }
    if (b.data_pagamento !== undefined){ fields.push('data_pagamento=?');   vals.push(b.data_pagamento || null); }
    if (b.observacoes !== undefined)   { fields.push('observacoes=?');      vals.push(b.observacoes); }
    if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    vals.push(id);
    await q(`UPDATE transactions SET ${fields.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/transactions/:id', auth, async (req, res) => {
  try {
    await q('DELETE FROM transactions WHERE id=?', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function calcTaxaMDR(formaNome, amount) {
  if (!formaNome) return 0;
  const fp = await q1('SELECT * FROM formas_pagamento WHERE nome=?', [formaNome]);
  if (!fp) return 0;
  return Number((Number(fp.taxa_intermediacao || 0) / 100 * amount + Number(fp.tarifa_fixa || 0)).toFixed(2));
}

// Normaliza registro do banco para o formato esperado pelo front-end
function normalizeTransaction(t) {
  return {
    ...t,
    type: t.tipo,
    date: t.data instanceof Date ? t.data.toISOString().slice(0, 10) : (t.data || '').toString().slice(0, 10),
    amount: Number(t.valor),
    description: t.descricao,
    grupo_contas: t.grupo,
    conta: t.conta_nome,
    forma_pagamento: t.forma_pagamento_nome,
    caixa_banco: t.caixa_nome,
    centro_custo: t.centro_custo_nome,
  };
}

// ── TRANSFERS ─────────────────────────────────────────────────────────────────
app.get('/api/transfers', auth, async (req, res) => {
  try {
    const { year, month } = req.query;
    let sql = 'SELECT * FROM transfers WHERE 1=1';
    const p = [];
    if (year)  { sql += ' AND YEAR(data)=?';  p.push(year); }
    if (month) { sql += ' AND MONTH(data)=?'; p.push(month); }
    sql += ' ORDER BY data DESC, id DESC';
    const rows = await q(sql, p);
    res.json(rows.map(t => ({
      ...t,
      date: t.data instanceof Date ? t.data.toISOString().slice(0,10) : (t.data||'').toString().slice(0,10),
      amount: Number(t.valor),
      caixa_saida: t.origem_nome,
      caixa_entrada: t.destino_nome,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/transfers', auth, async (req, res) => {
  try {
    const b = req.body;
    if (!b.date && !b.data) return res.status(400).json({ error: 'Campo obrigatório: date' });
    const result = await q(`
      INSERT INTO transfers (data, descricao, valor, origem_nome, destino_nome, observacoes, user_id)
      VALUES (?,?,?,?,?,?,?)`,
      [b.date || b.data, b.descricao || b.description || '',
       Number(b.amount || b.valor || 0),
       b.caixa_saida || b.origem_nome || '',
       b.caixa_entrada || b.destino_nome || '',
       b.observacoes || '', req.user.id]
    );
    res.json({ id: result.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/transfers/:id', auth, async (req, res) => {
  try {
    await q('DELETE FROM transfers WHERE id=?', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DRE RESUMO ────────────────────────────────────────────────────────────────
app.get('/api/dre/resumo', auth, async (req, res) => {
  try {
    const y = String(req.query.year || new Date().getFullYear());
    const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const txs = await q('SELECT tipo, data, valor FROM transactions WHERE YEAR(data)=?', [y]);
    const [{ si }] = await q('SELECT COALESCE(SUM(saldo_inicial),0) as si FROM caixas');

    let saldoAcum = Number(si);
    const summary = meses.map((nome, i) => {
      const m = i + 1;
      const mtxs = txs.filter(t => new Date(t.data).getMonth() + 1 === m);
      const receitas  = mtxs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.valor), 0);
      const despesas  = mtxs.filter(t => t.tipo === 'expense').reduce((s, t) => s + Number(t.valor), 0);
      const lucro     = receitas - despesas;
      const saldo_inicial = saldoAcum;
      saldoAcum += lucro;
      return { mes: nome, saldo_inicial, receitas, despesas, total: saldo_inicial + lucro, lucro, lucratividade: receitas > 0 ? lucro / receitas : 0 };
    });
    const totRec  = summary.reduce((s, m) => s + m.receitas, 0);
    const totDesp = summary.reduce((s, m) => s + m.despesas, 0);
    res.json({ summary, totals: { receitas: totRec, despesas: totDesp, lucro: totRec - totDesp, lucratividade: totRec > 0 ? (totRec - totDesp) / totRec : 0 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DRE DETALHADO ─────────────────────────────────────────────────────────────
app.get('/api/dre/detalhado', auth, async (req, res) => {
  try {
    const y = String(req.query.year || new Date().getFullYear());
    const txs = await q('SELECT tipo, data, valor, grupo, conta_nome FROM transactions WHERE YEAR(data)=?', [y]);
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const grupos = {};
    txs.forEach(t => {
      const key = `${t.tipo}||${t.grupo || 'Sem Grupo'}||${t.conta_nome || 'Geral'}`;
      if (!grupos[key]) grupos[key] = { type: t.tipo, grupo: t.grupo || 'Sem Grupo', conta: t.conta_nome || 'Geral', meses: Array(12).fill(0), total: 0 };
      const m = new Date(t.data).getMonth();
      grupos[key].meses[m] += Number(t.valor);
      grupos[key].total    += Number(t.valor);
    });
    const receitas = Object.values(grupos).filter(g => g.type === 'income').sort((a, b) => b.total - a.total);
    const despesas = Object.values(grupos).filter(g => g.type === 'expense').sort((a, b) => b.total - a.total);
    const totReceita = Array(12).fill(0);
    const totDespesa = Array(12).fill(0);
    receitas.forEach(r => r.meses.forEach((v, i) => totReceita[i] += v));
    despesas.forEach(d => d.meses.forEach((v, i) => totDespesa[i] += v));
    res.json({ meses, receitas, despesas, totReceita, totDespesa });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FLUXO DE CAIXA ────────────────────────────────────────────────────────────
app.get('/api/dre/fluxo-caixa', auth, async (req, res) => {
  try {
    const { year, month, caixa } = req.query;
    const y = String(year || new Date().getFullYear());
    const m = String(month || new Date().getMonth() + 1).padStart(2, '0');

    let sqlTx = 'SELECT tipo, data, valor FROM transactions WHERE YEAR(data)=? AND MONTH(data)=?';
    const pTx = [y, Number(m)];
    if (caixa && caixa !== 'Todos') { sqlTx += ' AND caixa_nome=?'; pTx.push(caixa); }

    let sqlTr = 'SELECT data, valor, origem_nome, destino_nome FROM transfers WHERE YEAR(data)=? AND MONTH(data)=?';
    const pTr = [y, Number(m)];
    if (caixa && caixa !== 'Todos') { sqlTr += ' AND (origem_nome=? OR destino_nome=?)'; pTr.push(caixa, caixa); }

    const [txs, trs] = await Promise.all([q(sqlTx, pTx), q(sqlTr, pTr)]);

    let sqlSaldo = 'SELECT COALESCE(SUM(saldo_inicial),0) as si FROM caixas';
    const pSaldo = [];
    if (caixa && caixa !== 'Todos') { sqlSaldo += ' WHERE nome=?'; pSaldo.push(caixa); }
    const [{ si }] = await q(sqlSaldo, pSaldo);

    const diasNoMes = new Date(Number(y), Number(m), 0).getDate();
    let saldoAcum = Number(si);
    const dias = [];
    for (let d = 1; d <= diasNoMes; d++) {
      const ds = `${y}-${m}-${String(d).padStart(2, '0')}`;
      const dayTxs = txs.filter(t => (t.data instanceof Date ? t.data.toISOString() : t.data.toString()).slice(0, 10) === ds);
      const dayTrs = trs.filter(t => (t.data instanceof Date ? t.data.toISOString() : t.data.toString()).slice(0, 10) === ds);
      const receita     = dayTxs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.valor), 0);
      const despesa     = dayTxs.filter(t => t.tipo === 'expense').reduce((s, t) => s + Number(t.valor), 0);
      const transferencia = dayTrs.reduce((s, t) => s + Number(t.valor), 0);
      const resultado   = receita - despesa;
      saldoAcum += resultado;
      dias.push({ data: ds, receita, despesa, transferencia, resultado, saldo: saldoAcum });
    }
    res.json(dias);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CENTRO DE CUSTO ───────────────────────────────────────────────────────────
app.get('/api/dre/centro-custo', auth, async (req, res) => {
  try {
    const { year, month, centro } = req.query;
    let sql = 'SELECT * FROM transactions WHERE 1=1';
    const p = [];
    if (year)   { sql += ' AND YEAR(data)=?';           p.push(year); }
    if (month)  { sql += ' AND MONTH(data)=?';          p.push(month); }
    if (centro) { sql += ' AND centro_custo_nome=?';    p.push(centro); }
    sql += ' ORDER BY data DESC';
    const txs = await q(sql, p);
    const total = txs.reduce((s, t) => s + (t.tipo === 'income' ? Number(t.valor) : -Number(t.valor)), 0);
    res.json({ transactions: txs.map(normalizeTransaction), total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FORMAS DE PAGAMENTO RELATÓRIO ─────────────────────────────────────────────
app.get('/api/dre/formas-pagamento', auth, async (req, res) => {
  try {
    const y = String(req.query.year || new Date().getFullYear());
    const [txs, fps] = await Promise.all([
      q('SELECT tipo, data, valor, forma_pagamento_nome, status FROM transactions WHERE YEAR(data)=?', [y]),
      q('SELECT nome FROM formas_pagamento'),
    ]);
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const result = fps.map(fp => {
      const fpTxs = txs.filter(t => t.forma_pagamento_nome === fp.nome);
      const mesesData = meses.map((_, i) => {
        const mTxs = fpTxs.filter(t => new Date(t.data).getMonth() === i);
        return {
          entradas:  mTxs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.valor), 0),
          saidas:    mTxs.filter(t => t.tipo === 'expense').reduce((s, t) => s + Number(t.valor), 0),
          em_aberto: mTxs.filter(t => t.status === 'em_aberto').reduce((s, t) => s + Number(t.valor), 0),
        };
      });
      return {
        forma: fp.nome, meses: mesesData,
        total_entradas: mesesData.reduce((s, m) => s + m.entradas, 0),
        total_saidas:   mesesData.reduce((s, m) => s + m.saidas, 0),
      };
    }).filter(f => f.total_entradas > 0 || f.total_saidas > 0);
    res.json({ meses, formas: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DRE LEGACY (dashboard) ────────────────────────────────────────────────────
app.get('/api/dre', auth, async (req, res) => {
  try {
    const y = String(req.query.year || new Date().getFullYear());
    // taxa_mdr precisa estar no SELECT — antes só vinha tipo/valor/centro_custo,
    // por isso as taxas de cartão nunca entravam em nenhuma conta do DRE.
    const txs = await q('SELECT tipo, data, valor, taxa_mdr, centro_custo_nome, grupo, conta_nome FROM transactions WHERE YEAR(data)=?', [y]);
    const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const summary = meses.map((nome, i) => {
      const m = i + 1;
      const mtxs       = txs.filter(t => new Date(t.data).getMonth() + 1 === m);
      const receitas   = mtxs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.valor || 0), 0);
      const deducoes   = mtxs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.taxa_mdr || 0), 0);
      const despesas   = mtxs.filter(t => t.tipo === 'expense').reduce((s, t) => s + Number(t.valor || 0), 0);
      return { month: nome, receitas, deducoes, despesas, saldo: receitas - deducoes - despesas };
    });

    // 1) Receita Bruta = soma de TODAS as receitas do período
    const receitaBruta = txs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.valor || 0), 0);
    // 2) Deduções = soma da taxa_mdr de TODAS as receitas (taxas de cartão/maquininha)
    const deducoes = txs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.taxa_mdr || 0), 0);
    // 3) Receita Líquida = Receita Bruta - Deduções
    const receitaLiquida = receitaBruta - deducoes;
    // 4) Despesas Operacionais = soma de TODAS as despesas do período
    const despesasOperacionais = txs.filter(t => t.tipo === 'expense').reduce((s, t) => s + Number(t.valor || 0), 0);
    // 5) Lucro Líquido = Receita Líquida - Despesas Operacionais
    const lucroLiquido = receitaLiquida - despesasOperacionais;

    const dreLines = {
      'Receita Bruta':               receitaBruta,
      '(-) Impostos e Deduções':     deducoes,
      'Receita Líquida':             receitaLiquida,
      '(-) Despesas Operacionais':   despesasOperacionais,
      'Lucro / Prejuízo Líquido':    lucroLiquido,
    };

    // Distribuição de despesas por grupo de contas (para gráfico donut)
    const expensesByCategory = {};
    txs.filter(t => t.tipo === 'expense').forEach(t => {
      const cat = t.grupo || t.centro_custo_nome || 'Outros';
      expensesByCategory[cat] = (expensesByCategory[cat] || 0) + Number(t.valor || 0);
    });

    res.json({ summary, dreLines, expensesByCategory, year: y });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── IMPORT ────────────────────────────────────────────────────────────────────
app.post('/api/import', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });
  const ext = req.file.originalname.split('.').pop().toLowerCase();
  let sheetData = {};
  try {
    if (['xlsx','xlsm','xls'].includes(ext)) {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      wb.SheetNames.forEach(name => { sheetData[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null }); });
    } else if (ext === 'csv') {
      sheetData['Planilha'] = req.file.buffer.toString('utf-8').split('\n').map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
    } else if (ext === 'xml') {
      const text = req.file.buffer.toString('utf-8');
      const rows = [];
      (text.match(/<Row[^>]*>([\s\S]*?)<\/Row>/gi) || []).forEach(row => {
        rows.push((row.match(/<Cell[^>]*>([\s\S]*?)<\/Cell>/gi) || []).map(c => c.replace(/<[^>]+>/g, '').trim()));
      });
      sheetData['Dados'] = rows;
    } else return res.status(400).json({ error: 'Formato não suportado' });

    const result = await q('INSERT INTO imported_sheets (filename, user_id) VALUES (?,?)', [req.file.originalname, req.user.id]);
    const sheetId = result.insertId;
    for (const [sName, rows] of Object.entries(sheetData)) {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row && row.some(c => c !== null && c !== '')) {
          await q('INSERT INTO imported_rows (sheet_id, sheet_name, row_index, data_json) VALUES (?,?,?,?)',
            [sheetId, sName, i, JSON.stringify(row)]);
        }
      }
    }
    res.json({ sheetId, filename: req.file.originalname, sheets: Object.keys(sheetData).map(n => ({ name: n, rowCount: sheetData[n].filter(r => r.some(c => c !== null && c !== '')).length })) });
  } catch (e) { res.status(500).json({ error: 'Erro ao processar: ' + e.message }); }
});

app.get('/api/import/:sid/sheets', auth, async (req, res) => {
  try {
    const rows = await q('SELECT DISTINCT sheet_name FROM imported_rows WHERE sheet_id=?', [Number(req.params.sid)]);
    res.json(rows.map(r => r.sheet_name));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/import/:sid/data/:name', auth, async (req, res) => {
  try {
    const rows = await q('SELECT row_index, data_json FROM imported_rows WHERE sheet_id=? AND sheet_name=? ORDER BY row_index', [Number(req.params.sid), req.params.name]);
    res.json(rows.map(r => ({ index: r.row_index, data: JSON.parse(r.data_json) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/imports', auth, async (req, res) => {
  try {
    res.json(await q('SELECT * FROM imported_sheets ORDER BY uploaded_at DESC LIMIT 20'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EXPORT EXCEL ──────────────────────────────────────────────────────────────
app.get('/api/export/excel', auth, async (req, res) => {
  try {
    const y   = String(req.query.year || new Date().getFullYear());
    const txs = await q('SELECT * FROM transactions WHERE YEAR(data)=? ORDER BY data', [y]);
    const trs = await q('SELECT * FROM transfers WHERE YEAR(data)=? ORDER BY data', [y]);
    const wb  = XLSX.utils.book_new();
    const h   = ['ID','Data','Tipo','Centro de Custo','Grupo','Conta','Forma Pagamento','Caixa/Banco','Cliente/Fornecedor','Valor Bruto','Taxa MDR','Valor Líquido','Status'];
    const txData = [h, ...txs.map(t => [t.id, t.data, t.tipo === 'income' ? 'Receita' : 'Despesa', t.centro_custo_nome, t.grupo, t.conta_nome, t.forma_pagamento_nome, t.caixa_nome, t.cliente_fornecedor, Number(t.valor), Number(t.taxa_mdr || 0), Number(t.valor_liquido || t.valor), t.status])];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(txData), 'Lançamentos');
    const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const dreData = [['Mês','Receitas','Despesas','Lucro']];
    meses.forEach((n, i) => {
      const m   = i + 1;
      const rec = txs.filter(t => new Date(t.data).getMonth() + 1 === m && t.tipo === 'income').reduce((s, t) => s + Number(t.valor), 0);
      const des = txs.filter(t => new Date(t.data).getMonth() + 1 === m && t.tipo === 'expense').reduce((s, t) => s + Number(t.valor), 0);
      dreData.push([n, rec, des, rec - des]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dreData), 'DRE Resumo');
    const trData = [['ID','Data','Origem','Destino','Valor','Observações'], ...trs.map(t => [t.id, t.data, t.origem_nome, t.destino_nome, Number(t.valor), t.observacoes])];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(trData), 'Transferências');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=DRE_${y}.xlsx`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/export/csv', auth, async (req, res) => {
  try {
    const y   = String(req.query.year || new Date().getFullYear());
    const txs = await q('SELECT * FROM transactions WHERE YEAR(data)=? ORDER BY data', [y]);
    const lines = ['ID,Data,Tipo,Centro de Custo,Grupo,Conta,Forma Pagamento,Caixa/Banco,Cliente/Fornecedor,Valor,Taxa MDR,Valor Líquido,Status'];
    txs.forEach(t => lines.push([t.id, t.data, t.tipo === 'income' ? 'Receita' : 'Despesa', t.centro_custo_nome || '', t.grupo || '', t.conta_nome || '', t.forma_pagamento_nome || '', t.caixa_nome || '', t.cliente_fornecedor || '', Number(t.valor), Number(t.taxa_mdr || 0), Number(t.valor_liquido || t.valor), t.status].join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=DRE_${y}.csv`);
    res.send('\ufeff' + lines.join('\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/export/xml', auth, async (req, res) => {
  try {
    const y   = String(req.query.year || new Date().getFullYear());
    const txs = await q('SELECT * FROM transactions WHERE YEAR(data)=?', [y]);
    const esc = s => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<DRE ano="${y}">\n`;
    txs.forEach(t => { xml += `  <Lancamento><ID>${t.id}</ID><Data>${t.data}</Data><Tipo>${t.tipo === 'income' ? 'Receita' : 'Despesa'}</Tipo><CentroCusto>${esc(t.centro_custo_nome)}</CentroCusto><Valor>${Number(t.valor)}</Valor><TaxaMDR>${Number(t.taxa_mdr || 0)}</TaxaMDR><ValorLiquido>${Number(t.valor_liquido || t.valor)}</ValorLiquido><Status>${esc(t.status)}</Status></Lancamento>\n`; });
    xml += '</DRE>';
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=DRE_${y}.xml`);
    res.send(xml);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/export/pdf', auth, async (req, res) => {
  try {
    const y   = String(req.query.year || new Date().getFullYear());
    const txs = await q('SELECT * FROM transactions WHERE YEAR(data)=?', [y]);
    const totalRec  = txs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.valor), 0);
    const totalDesp = txs.filter(t => t.tipo === 'expense').reduce((s, t) => s + Number(t.valor), 0);
    const lucro     = totalRec - totalDesp;
    const fmt       = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    const meses     = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const doc       = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=DRE_${y}.pdf`);
    doc.pipe(res);
    doc.fontSize(20).fillColor('#1a1a1a').text('DRE — Demonstrativo do Resultado do Exercício', { align: 'center' });
    doc.fontSize(12).fillColor('#666').text(`OAF - Odirlei Amaro Ferreira  |  Ano: ${y}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#e0e0e0').stroke();
    doc.moveDown(1);
    const impostos = txs.filter(t => t.centro_custo_nome === 'DESPESAS DE IMPOSTOS').reduce((s, t) => s + Number(t.valor), 0);
    const despOp   = txs.filter(t => t.centro_custo_nome === 'DESPESAS OPERACIONAIS').reduce((s, t) => s + Number(t.valor), 0);
    const despAdm  = totalDesp - impostos - despOp;
    const taxaTotal= txs.reduce((s, t) => s + Number(t.taxa_mdr || 0), 0);
    const recLiq   = totalRec - impostos - taxaTotal;
    [
      { label: 'RECEITA BRUTA', val: totalRec, bold: true, color: '#1a1a1a' },
      { label: '(-) Taxa MDR / Intermediação', val: -taxaTotal, color: '#dc2626' },
      { label: '(-) Impostos e Deduções', val: -impostos, color: '#dc2626' },
      { label: 'RECEITA LÍQUIDA', val: recLiq, bold: true, color: '#1a1a1a' },
      { label: '(-) Despesas Operacionais', val: -despOp, color: '#dc2626' },
      { label: '(-) Despesas Administrativas', val: -despAdm, color: '#dc2626' },
      { label: 'LUCRO / PREJUÍZO LÍQUIDO', val: lucro, bold: true, color: lucro >= 0 ? '#059669' : '#dc2626', highlight: true },
    ].forEach(line => {
      if (line.highlight) { const yy = doc.y; doc.rect(50, yy - 3, 495, 22).fill('#f0fdf4'); }
      doc.fontSize(line.bold ? 11 : 10).fillColor(line.color).font(line.bold ? 'Helvetica-Bold' : 'Helvetica').text(line.label, 55, doc.y, { continued: true }).text(fmt(line.val), { align: 'right' });
      doc.moveDown(0.4);
    });
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#e0e0e0').stroke();
    doc.moveDown(0.5);
    doc.fontSize(13).fillColor('#1a1a1a').font('Helvetica-Bold').text('Resumo Mensal');
    doc.moveDown(0.5);
    const colX = [55, 195, 300, 390, 480];
    const hY = doc.y;
    doc.fontSize(9).fillColor('#666').font('Helvetica-Bold').text('Mês', colX[0], hY).text('Receitas', colX[1], hY).text('Despesas', colX[2], hY).text('Lucro', colX[3], hY).text('Lucrativ.', colX[4], hY);
    doc.moveDown(0.3);
    meses.forEach((nome, i) => {
      const m   = i + 1;
      const rec = txs.filter(t => t.tipo === 'income'  && new Date(t.data).getMonth() + 1 === m).reduce((s, t) => s + Number(t.valor), 0);
      const des = txs.filter(t => t.tipo === 'expense' && new Date(t.data).getMonth() + 1 === m).reduce((s, t) => s + Number(t.valor), 0);
      const lc  = rec - des;
      const rY  = doc.y;
      doc.fontSize(9).font('Helvetica').fillColor('#1a1a1a').text(nome, colX[0], rY).text(fmt(rec), colX[1], rY).text(fmt(des), colX[2], rY).fillColor(lc >= 0 ? '#059669' : '#dc2626').text(fmt(lc), colX[3], rY).text(rec > 0 ? (lc / rec * 100).toFixed(1) + '%' : '0%', colX[4], rY);
      doc.moveDown(0.2);
    });
    doc.fontSize(8).fillColor('#aaa').text(`Gerado em ${new Date().toLocaleString('pt-BR')}`, 50, doc.page.height - 60, { align: 'center' });
    doc.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CADASTROS CRUD GENÉRICO ───────────────────────────────────────────────────
function crudRoutes(table, requiredFields = []) {
  app.get(`/api/${table}`, auth, async (req, res) => {
    try { res.json(await q(`SELECT * FROM \`${table}\` ORDER BY id`)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post(`/api/${table}`, auth, async (req, res) => {
    try {
      const b = req.body;
      for (const f of requiredFields) if (!b[f]) return res.status(400).json({ error: `Campo obrigatório: ${f}` });
      const keys   = Object.keys(b).filter(k => b[k] !== undefined);
      const vals   = keys.map(k => b[k]);
      const result = await q(
        `INSERT INTO \`${table}\` (${keys.map(k => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
        vals
      );
      res.json({ id: result.insertId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put(`/api/${table}/:id`, auth, async (req, res) => {
    try {
      const b    = req.body;
      const id   = Number(req.params.id);
      const keys = Object.keys(b).filter(k => b[k] !== undefined);
      if (!keys.length) return res.json({ ok: true });
      await q(
        `UPDATE \`${table}\` SET ${keys.map(k => `\`${k}\`=?`).join(',')} WHERE id=?`,
        [...keys.map(k => b[k]), id]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete(`/api/${table}/:id`, auth, async (req, res) => {
    try {
      await q(`DELETE FROM \`${table}\` WHERE id=?`, [Number(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

crudRoutes('clientes',          ['nome']);
crudRoutes('fornecedores',      ['nome']);
crudRoutes('contas_receita',    ['grupo']);
crudRoutes('contas_despesa',    ['grupo']);
crudRoutes('centros_custo',     ['nome']);
crudRoutes('caixas',            ['nome']);
crudRoutes('formas_pagamento',  ['nome']);

// ── ALL CADASTROS (summary) ───────────────────────────────────────────────────
app.get('/api/cadastros', auth, async (req, res) => {
  try {
    const [fps, cxs, ccs, cr, cd, clis, forns] = await Promise.all([
      q('SELECT nome FROM formas_pagamento ORDER BY id'),
      q('SELECT nome FROM caixas ORDER BY id'),
      q('SELECT nome FROM centros_custo ORDER BY id'),
      q('SELECT id, grupo, conta FROM contas_receita ORDER BY id'),
      q('SELECT id, grupo, conta FROM contas_despesa ORDER BY id'),
      q('SELECT nome FROM clientes ORDER BY nome'),
      q('SELECT nome FROM fornecedores ORDER BY nome'),
    ]);
    res.json({
      formasPagamento:       fps.map(f => f.nome),
      caixasBancos:          cxs.map(c => c.nome),
      centrosCusto:          ccs.map(c => c.nome),
      gruposContasReceita:   [...new Set(cr.map(c => c.grupo))],
      gruposContasDespesa:   [...new Set(cd.map(c => c.grupo))],
      contasReceita:         cr,
      contasDespesa:         cd,
      clientes:              clis.map(c => c.nome),
      fornecedores:          forns.map(f => f.nome),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── USERS ─────────────────────────────────────────────────────────────────────
app.get('/api/users', auth, adminOnly, async (req, res) => {
  try { res.json(await q('SELECT id, username, role, created_at FROM users ORDER BY id')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Cadastro interno de usuários: só um admin autenticado pode criar novos acessos.
// Não mexe no cookie de sessão de quem está criando (o admin continua logado).
app.post('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Campos obrigatórios' });
    if (password.length < 4) return res.status(400).json({ error: 'Senha muito curta' });
    const existing = await q1('SELECT id FROM users WHERE username=?', [username]);
    if (existing) return res.status(400).json({ error: 'Usuário já existe' });
    const finalRole = role === 'admin' ? 'admin' : 'user';
    const hash = await bcrypt.hash(password, 10);
    const result = await q('INSERT INTO users (username, password, role) VALUES (?,?,?)', [username, hash, finalRole]);
    res.json({ id: result.insertId, username, role: finalRole });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:id/role', auth, adminOnly, async (req, res) => {
  try {
    await q('UPDATE users SET role=? WHERE id=?', [req.body.role, Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Não pode deletar a si mesmo' });
    await q('DELETE FROM users WHERE id=?', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STARTUP ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    await initDb();
    await migrarLegado();
    app.listen(PORT, () => console.log(`🚀 DRE System rodando em http://localhost:${PORT}`));
  } catch (e) {
    console.error('❌ Erro ao inicializar banco de dados:', e.message);
    console.error('   Verifique as configurações no arquivo .env');
    process.exit(1);
  }
})();
