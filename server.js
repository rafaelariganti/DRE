const express      = require('express');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const multer       = require('multer');
const XLSX         = require('xlsx');
const PDFDocument  = require('pdfkit');
const cookieParser = require('cookie-parser');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const { initDb, migrarLegado, getPool } = require('./database');

const app        = express();
const PORT       = process.env.PORT || 3000;
const IS_PROD    = process.env.NODE_ENV === 'production';
const upload     = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── UPLOADS: PARCEIROS (foto / contrato) ──────────────────────────────────────
// Anexos ficam gravados em disco (fora do public/) e são servidos por rota
// dedicada. Nome do arquivo é regravado (timestamp + hex aleatório) pra evitar
// colisão e pra não confiar no nome original vindo do navegador.
const PARCEIROS_UPLOAD_DIR = path.join(__dirname, 'uploads', 'parceiros');
fs.mkdirSync(PARCEIROS_UPLOAD_DIR, { recursive: true });
const uploadParceiro = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PARCEIROS_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ── UPLOADS: PERFIL (foto do usuário) ─────────────────────────────────────────
const PERFIL_UPLOAD_DIR = path.join(__dirname, 'uploads', 'perfil');
fs.mkdirSync(PERFIL_UPLOAD_DIR, { recursive: true });
const uploadPerfil = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PERFIL_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
});

// ── JWT SECRET ────────────────────────────────────────────────────────────────
// Nunca usar segredo fixo no código: quem lê o repositório (ou o zip) descobre a
// chave e consegue forjar tokens de admin. Se JWT_SECRET não vier do ambiente,
// gera um segredo aleatório só pra essa execução (isso força logout a cada
// restart do processo — é o preço aceitável de não ter um segredo fraco).
if (!process.env.JWT_SECRET) {
  console.warn('[SEGURANÇA] JWT_SECRET não definido no ambiente. Gerando um segredo temporário para esta execução.');
  console.warn('[SEGURANÇA] Defina JWT_SECRET no .env em produção, ou todas as sessões caem a cada restart.');
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');

// ── SECURITY HEADERS ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
// setHeaders desliga o cache do navegador pra HTML/JS/CSS da interface: sem
// isso, depois de cada atualização do sistema o usuário via ver telas antigas
// (ex: menu de Usuários aparecendo pra quem não é admin) até limpar o cache
// manualmente. Uploads (fotos/anexos) continuam com cache normal, sem problema.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'),
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── RATE LIMITING (login / cadastro) ──────────────────────────────────────────
// Limitador simples em memória, sem dependência externa: por IP+rota, N tentativas
// por janela de tempo. Objetivo é frear força bruta e enumeração de usuário/senha.
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  return (req, res, next) => {
    const id = key + ':' + (req.ip || req.headers['x-forwarded-for'] || 'unknown');
    const now = Date.now();
    let bucket = rateBuckets.get(id);
    if (!bucket || now - bucket.start > windowMs) { bucket = { start: now, count: 0 }; rateBuckets.set(id, bucket); }
    bucket.count++;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde um pouco antes de tentar novamente.' });
    }
    next();
  };
}
// limpeza periódica pra não crescer indefinidamente em memória
setInterval(() => {
  const now = Date.now();
  for (const [id, b] of rateBuckets) if (now - b.start > 15 * 60 * 1000) rateBuckets.delete(id);
}, 5 * 60 * 1000);

// ── VALIDAÇÃO DE INPUT (auth) ─────────────────────────────────────────────────
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
function validCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return 'Campos obrigatórios';
  if (!USERNAME_RE.test(username)) return 'Usuário deve ter 3-32 caracteres (letras, números, _ . -)';
  if (password.length < 6) return 'Senha deve ter pelo menos 6 caracteres';
  return null;
}

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

// Log de atividades: registra quem fez o quê. Nunca deve derrubar a requisição
// principal — se o log falhar (ex: tabela ainda não migrada), só loga no console.
async function logAction(req, action, entity, entityId = null, details = null) {
  try {
    const userId   = req.user ? req.user.id : null;
    const username = req.user ? req.user.username : (req.body && req.body.username) || null;
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0, 64);
    await q(
      'INSERT INTO logs (user_id, username, action, entity, entity_id, details, ip) VALUES (?,?,?,?,?,?,?)',
      [userId, username, action, entity, entityId, details ? String(details).slice(0, 500) : null, ip]
    );
  } catch (e) { console.error('[LOG] falha ao registrar:', e.message); }
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
// Busca o usuário atual no banco a cada requisição (não confia só no JWT) pra
// que mudanças de função/permissões feitas por um admin valham imediatamente,
// sem precisar esperar o token expirar ou pedir novo login.
function auth(req, res, next) {
  const token = req.cookies.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
  q1('SELECT id, username, role, nome, foto_path, foto_nome, permissoes FROM users WHERE id=?', [payload.id])
    .then(user => {
      if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
      req.user = user;
      next();
    })
    .catch(e => res.status(500).json({ error: e.message }));
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito' });
  next();
}

// ── PERMISSÕES DE TELA (usuários não-admin) ───────────────────────────────────
// Lista de telas que podem ser liberadas seletivamente pra um usuário comum.
// O próprio perfil fica sempre acessível pra qualquer um logado — Dashboard
// agora é opcional (tem dado sensível) e entra nessa lista como as demais.
const PAGINAS_PERMISSAO = [
  'dashboard', 'lancamentos',
  'dre-resumo', 'dre-detalhado', 'fluxo-caixa', 'formas-pagamento-rel',
  'cad-clientes', 'cad-fornecedores', 'cad-parceiros', 'cad-caixas', 'cad-formas',
  'import',
];
function sanitizarPermissoes(input) {
  let arr = input;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.filter(p => PAGINAS_PERMISSAO.includes(p)))];
}
function temPermissao(user, ...paginas) {
  if (user.role === 'admin') return true;
  let perms = [];
  try { perms = JSON.parse(user.permissoes || '[]'); } catch { perms = []; }
  return paginas.some(p => perms.includes(p));
}
// Middleware: bloqueia a rota se o usuário (não-admin) não tiver nenhuma das
// telas informadas liberada. Segunda camada de proteção — a UI já esconde o
// menu, isso aqui impede acesso direto via API.
function permitirPaginas(...paginas) {
  return (req, res, next) => {
    if (temPermissao(req.user, ...paginas)) return next();
    res.status(403).json({ error: 'Sem permissão de acesso a esta tela' });
  };
}
// Cookie do JWT: httpOnly (JS do navegador não lê), sameSite=strict (não vaza em
// requisições cross-site) e secure em produção (só viaja em HTTPS).
function cookieOpts() {
  return { httpOnly: true, sameSite: 'strict', secure: IS_PROD, maxAge: 7 * 24 * 3600 * 1000 };
}
// Formato enviado ao front-end: nunca a senha, e permissões sempre como array
// (o banco guarda como texto JSON).
function userOut(u) {
  let permissoes = [];
  try { permissoes = JSON.parse(u.permissoes || '[]'); } catch { permissoes = []; }
  return {
    id: u.id, username: u.username, role: u.role,
    nome: u.nome || null, foto_path: u.foto_path || null, foto_nome: u.foto_nome || null,
    permissoes,
  };
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
// Cadastro público só existe para o "bootstrap" do sistema (primeiro admin, quando
// ainda não há nenhum usuário no banco). Depois disso, novos usuários só podem ser
// criados por um admin já autenticado, de dentro do painel (ver POST /api/users).
app.post('/api/auth/register', rateLimit('register', 5, 10 * 60 * 1000), async (req, res) => {
  try {
    const [{ n }] = await q('SELECT COUNT(*) as n FROM users');
    if (n > 0) return res.status(403).json({ error: 'Cadastro público desativado. Peça a um administrador para criar seu acesso.' });
    const { username, password } = req.body || {};
    const err = validCredentials(username, password);
    if (err) return res.status(400).json({ error: err });
    const hash = await bcrypt.hash(password, 10);
    const result = await q('INSERT INTO users (username, password, role) VALUES (?,?,?)', [username, hash, 'admin']);
    const id = result.insertId;
    const role = 'admin';
    const token = jwt.sign({ id, username, role }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, cookieOpts());
    await logAction(req, 'setup_admin', 'auth', id, `Primeiro admin criado: ${username}`);
    res.json(userOut({ id, username, role, nome: null, foto_path: null, foto_nome: null, permissoes: null }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sinaliza pro front se o sistema já tem algum usuário (controla o link "Configurar acesso inicial").
app.get('/api/auth/setup-status', async (req, res) => {
  try {
    const [{ n }] = await q('SELECT COUNT(*) as n FROM users');
    res.json({ needsSetup: n === 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', rateLimit('login', 8, 10 * 60 * 1000), async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password)
      return res.status(400).json({ error: 'Credenciais inválidas' });
    const user = await q1('SELECT * FROM users WHERE username=?', [username]);
    if (!user || !await bcrypt.compare(password, user.password)) {
      await logAction(req, 'login_failed', 'auth', null, `Tentativa falhou para usuário: ${username}`);
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, cookieOpts());
    req.user = user;
    await logAction(req, 'login', 'auth', user.id);
    res.json(userOut(user));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', auth, async (req, res) => {
  await logAction(req, 'logout', 'auth', req.user.id);
  res.clearCookie('token'); res.json({ ok: true });
});
app.get('/api/auth/me', auth, (req, res) => res.json(userOut(req.user)));

// Edita o PRÓPRIO perfil: nome, foto e (opcionalmente) senha. Não usa o CRUD de
// /api/users porque troca a senha do usuário logado, não de um usuário-alvo.
app.put('/api/auth/profile', auth, uploadPerfil.single('foto'), async (req, res) => {
  try {
    const b = req.body || {};
    const atual = await q1('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!atual) return res.status(404).json({ error: 'Usuário não encontrado' });

    const nome = (b.nome || '').trim() || null;
    let senhaHash = atual.password;
    if (b.password && b.password.trim()) {
      if (b.password.trim().length < 4) return res.status(400).json({ error: 'A nova senha deve ter ao menos 4 caracteres' });
      senhaHash = await bcrypt.hash(b.password.trim(), 10);
    }

    let fotoPath = atual.foto_path, fotoNome = atual.foto_nome;
    if (req.file) {
      if (atual.foto_path) fs.unlink(path.join(__dirname, atual.foto_path.replace(/^\//, '')), () => {});
      fotoPath = `/uploads/perfil/${req.file.filename}`;
      fotoNome = req.file.originalname;
    }

    await q('UPDATE users SET nome=?, password=?, foto_path=?, foto_nome=? WHERE id=?', [nome, senhaHash, fotoPath, fotoNome, req.user.id]);
    await logAction(req, 'update', 'users', req.user.id, 'Atualizou o próprio perfil');
    const atualizado = await q1('SELECT id, username, role, nome, foto_path, foto_nome, permissoes FROM users WHERE id=?', [req.user.id]);
    res.json(userOut(atualizado));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TRANSACTIONS ──────────────────────────────────────────────────────────────
app.get('/api/transactions', auth, permitirPaginas('lancamentos'), async (req, res) => {
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

app.post('/api/transactions', auth, permitirPaginas('lancamentos'), async (req, res) => {
  try {
    const b = req.body;
    if (!b.date && !b.data) return res.status(400).json({ error: 'Campo obrigatório: date' });
    if (!b.type && !b.tipo) return res.status(400).json({ error: 'Campo obrigatório: type' });
    if (b.amount == null && b.valor == null) return res.status(400).json({ error: 'Campo obrigatório: amount' });

    const tipo  = b.type  || b.tipo;
    const data  = b.date  || b.data;
    const valor = Number(b.amount || b.valor || 0);
    // MDR (taxa de maquininha/adquirente) só faz sentido em RECEITA — cobrar essa taxa
    // numa despesa fazia o "valor líquido" ficar menor que o valor pago, como se a
    // despesa desse desconto. Ver auditoria-dre.md, item 5.
    const taxa  = tipo === 'income' ? await calcTaxaMDR(b.forma_pagamento || b.forma_pagamento_nome, valor) : 0;

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
       // status só existe como 'em_aberto' ou 'quitado' no resto do sistema (Contas a
       // Pagar/Receber filtra exatamente por esses dois valores). O default antigo
       // ('realizado') não batia com esse vocabulário — um lançamento criado sem
       // status explícito sumia de toda a tela de Contas a Pagar/Receber, mesmo
       // contando normalmente no DRE. Ver auditoria-dre.md, item 6.
       (b.status==='em_aberto'?'em_aberto':'quitado'),
       b.data_vencimento || null,
       b.data_pagamento  || null,
       taxa, valor - taxa,
       b.observacoes || '',
       req.user.id]
    );
    await logAction(req, 'create', 'transactions', result.insertId, `${tipo} - ${b.description||b.descricao||''} - R$${valor}`);
    res.json({ id: result.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/transactions/:id', auth, permitirPaginas('lancamentos'), async (req, res) => {
  try {
    const b    = req.body;
    const id   = Number(req.params.id);
    const valor = Number(b.amount || b.valor || 0);
    const tipoEdit = b.type || b.tipo;
    const taxa  = tipoEdit === 'income' ? await calcTaxaMDR(b.forma_pagamento || b.forma_pagamento_nome, valor) : 0;
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
       (b.status==='em_aberto'?'em_aberto':'quitado'),
       b.data_vencimento || null,
       b.data_pagamento  || null,
       taxa, valor - taxa,
       b.observacoes || '',
       id]
    );
    await logAction(req, 'update', 'transactions', id, `${b.type||b.tipo} - ${b.description||b.descricao||''} - R$${valor}`);
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
    await logAction(req, b.status==='quitado'?'baixa':'update_status', 'transactions', id, b.status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/transactions/:id', auth, permitirPaginas('lancamentos'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    // Busca a linha ANTES de apagar, pra o log guardar o que era o lançamento.
    // Sem isso, depois de excluído o log só diz "excluído #42" sem valor/descrição —
    // ruim demais pra auditoria num sistema financeiro. Ver auditoria-dre.md, item 7.
    const row = await q1('SELECT tipo, valor, descricao FROM transactions WHERE id=?', [id]);
    await q('DELETE FROM transactions WHERE id=?', [id]);
    await logAction(req, 'delete', 'transactions', id, row ? `${row.tipo} - ${row.descricao || ''} - R$${row.valor}` : null);
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
app.get('/api/transfers', auth, permitirPaginas('lancamentos'), async (req, res) => {
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

app.post('/api/transfers', auth, permitirPaginas('lancamentos'), async (req, res) => {
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
    await logAction(req, 'create', 'transfers', result.insertId, `${b.caixa_saida||b.origem_nome} → ${b.caixa_entrada||b.destino_nome} - R$${Number(b.amount||b.valor||0)}`);
    res.json({ id: result.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/transfers/:id', auth, permitirPaginas('lancamentos'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await q1('SELECT valor, origem_nome, destino_nome FROM transfers WHERE id=?', [id]);
    await q('DELETE FROM transfers WHERE id=?', [id]);
    await logAction(req, 'delete', 'transfers', id, row ? `${row.origem_nome} → ${row.destino_nome} - R$${row.valor}` : null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DRE RESUMO ────────────────────────────────────────────────────────────────
// A receita usada aqui é sempre a RECEITA LÍQUIDA (bruta - taxa_mdr), pra ficar
// consistente com o Dashboard (GET /api/dre). Antes essa rota somava o valor bruto
// sem descontar a taxa, e o Dashboard descontava — o mesmo ano dava lucro diferente
// dependendo da tela. Ver auditoria-dre.md, item 2.
app.get('/api/dre/resumo', auth, permitirPaginas('dre-resumo'), async (req, res) => {
  try {
    const y = String(req.query.year || new Date().getFullYear());
    const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const txs = await q('SELECT tipo, data, valor, taxa_mdr FROM transactions WHERE YEAR(data)=?', [y]);
    const [{ si }] = await q('SELECT COALESCE(SUM(saldo_inicial),0) as si FROM caixas');

    let saldoAcum = Number(si);
    const summary = meses.map((nome, i) => {
      const m = i + 1;
      const mtxs = txs.filter(t => new Date(t.data).getMonth() + 1 === m);
      const receitaBruta = mtxs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.valor), 0);
      const deducoes      = mtxs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.taxa_mdr || 0), 0);
      const receitas       = receitaBruta - deducoes; // receita líquida
      const despesas       = mtxs.filter(t => t.tipo === 'expense').reduce((s, t) => s + Number(t.valor), 0);
      const lucro          = receitas - despesas;
      const saldo_inicial  = saldoAcum;
      saldoAcum += lucro;
      return { mes: nome, saldo_inicial, receita_bruta: receitaBruta, deducoes, receitas, despesas, total: saldo_inicial + lucro, lucro, lucratividade: receitas > 0 ? lucro / receitas : 0 };
    });
    const totRec  = summary.reduce((s, m) => s + m.receitas, 0);
    const totDesp = summary.reduce((s, m) => s + m.despesas, 0);
    res.json({ summary, totals: { receitas: totRec, despesas: totDesp, lucro: totRec - totDesp, lucratividade: totRec > 0 ? (totRec - totDesp) / totRec : 0 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DRE DETALHADO ─────────────────────────────────────────────────────────────
// A receita agregada por grupo/conta usa o valor líquido (desconta taxa_mdr) pra
// bater com o Dashboard e o DRE Resumo. Ver auditoria-dre.md, item 2.
app.get('/api/dre/detalhado', auth, permitirPaginas('dre-detalhado'), async (req, res) => {
  try {
    const y = String(req.query.year || new Date().getFullYear());
    const txs = await q('SELECT tipo, data, valor, taxa_mdr, grupo, conta_nome FROM transactions WHERE YEAR(data)=?', [y]);
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const grupos = {};
    txs.forEach(t => {
      const key = `${t.tipo}||${t.grupo || 'Sem Grupo'}||${t.conta_nome || 'Geral'}`;
      if (!grupos[key]) grupos[key] = { type: t.tipo, grupo: t.grupo || 'Sem Grupo', conta: t.conta_nome || 'Geral', meses: Array(12).fill(0), total: 0 };
      const valorLiquido = t.tipo === 'income' ? Number(t.valor) - Number(t.taxa_mdr || 0) : Number(t.valor);
      const m = new Date(t.data).getMonth();
      grupos[key].meses[m] += valorLiquido;
      grupos[key].total    += valorLiquido;
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
// Separa REALIZADO (dinheiro que já entrou/saiu de fato — status='quitado', na
// data em que o pagamento aconteceu) de PREVISTO (título ainda em aberto, na data
// de vencimento). Antes essa rota somava tudo junto pela data do lançamento, sem
// olhar o status — um título "em_aberto" derrubava o saldo do dia como se o
// dinheiro já tivesse saído da conta, mesmo sem ter sido pago ainda.
// Ver auditoria-dre.md, item 3.
function toDateStr(v) {
  return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
}

app.get('/api/dre/fluxo-caixa', auth, permitirPaginas('fluxo-caixa'), async (req, res) => {
  try {
    const { year, month, caixa } = req.query;
    const y = String(year || new Date().getFullYear());
    const m = String(month || new Date().getMonth() + 1).padStart(2, '0');

    // REALIZADO: só título já quitado, na data em que o dinheiro efetivamente
    // moveu (data_pagamento; se não tiver sido preenchida, cai pra data do
    // lançamento como fallback, pra não perder o registro do relatório).
    let sqlReal = `SELECT tipo, COALESCE(data_pagamento, data) as data_efetiva, valor
                   FROM transactions
                   WHERE status='quitado'
                     AND YEAR(COALESCE(data_pagamento, data))=? AND MONTH(COALESCE(data_pagamento, data))=?`;
    const pReal = [y, Number(m)];
    if (caixa && caixa !== 'Todos') { sqlReal += ' AND caixa_nome=?'; pReal.push(caixa); }

    // PREVISTO: só título em aberto, na data de vencimento (ou data do
    // lançamento, se não tiver vencimento cadastrado).
    let sqlPrev = `SELECT tipo, COALESCE(data_vencimento, data) as data_efetiva, valor
                   FROM transactions
                   WHERE status='em_aberto'
                     AND YEAR(COALESCE(data_vencimento, data))=? AND MONTH(COALESCE(data_vencimento, data))=?`;
    const pPrev = [y, Number(m)];
    if (caixa && caixa !== 'Todos') { sqlPrev += ' AND caixa_nome=?'; pPrev.push(caixa); }

    let sqlTr = 'SELECT data, valor, origem_nome, destino_nome FROM transfers WHERE YEAR(data)=? AND MONTH(data)=?';
    const pTr = [y, Number(m)];
    if (caixa && caixa !== 'Todos') { sqlTr += ' AND (origem_nome=? OR destino_nome=?)'; pTr.push(caixa, caixa); }

    const [realTxs, prevTxs, trs] = await Promise.all([q(sqlReal, pReal), q(sqlPrev, pPrev), q(sqlTr, pTr)]);

    let sqlSaldo = 'SELECT COALESCE(SUM(saldo_inicial),0) as si FROM caixas';
    const pSaldo = [];
    if (caixa && caixa !== 'Todos') { sqlSaldo += ' WHERE nome=?'; pSaldo.push(caixa); }
    const [{ si }] = await q(sqlSaldo, pSaldo);

    const diasNoMes = new Date(Number(y), Number(m), 0).getDate();
    let saldoAcum = Number(si);           // saldo real (só o que já aconteceu)
    let saldoProjetadoAcum = Number(si);  // saldo real + o que está previsto
    const dias = [];
    for (let d = 1; d <= diasNoMes; d++) {
      const ds = `${y}-${m}-${String(d).padStart(2, '0')}`;
      const dReal = realTxs.filter(t => toDateStr(t.data_efetiva) === ds);
      const dPrev = prevTxs.filter(t => toDateStr(t.data_efetiva) === ds);
      const dTrs  = trs.filter(t => toDateStr(t.data) === ds);

      const receita = dReal.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.valor), 0);
      const despesa = dReal.filter(t => t.tipo === 'expense').reduce((s, t) => s + Number(t.valor), 0);
      const receitaPrevista = dPrev.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.valor), 0);
      const despesaPrevista = dPrev.filter(t => t.tipo === 'expense').reduce((s, t) => s + Number(t.valor), 0);

      // Transferência: quando filtrado por um caixa específico, precisa ENTRAR no saldo
      // (dinheiro chegou ou saiu daquele caixa). Ver auditoria-dre.md, item 4.
      const transferenciaEntrada = (caixa && caixa !== 'Todos') ? dTrs.filter(t => t.destino_nome === caixa).reduce((s, t) => s + Number(t.valor), 0) : 0;
      const transferenciaSaida   = (caixa && caixa !== 'Todos') ? dTrs.filter(t => t.origem_nome  === caixa).reduce((s, t) => s + Number(t.valor), 0) : 0;
      const transferencia = dTrs.reduce((s, t) => s + Number(t.valor), 0);

      const resultado = receita - despesa + transferenciaEntrada - transferenciaSaida;
      saldoAcum += resultado;

      const previsto = receitaPrevista - despesaPrevista;
      saldoProjetadoAcum += resultado + previsto;

      dias.push({
        data: ds, receita, despesa, transferencia, resultado, saldo: saldoAcum,
        receita_prevista: receitaPrevista, despesa_prevista: despesaPrevista,
        previsto, saldo_projetado: saldoProjetadoAcum,
      });
    }
    res.json(dias);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CENTRO DE CUSTO ───────────────────────────────────────────────────────────
app.get('/api/dre/centro-custo', auth, permitirPaginas('centro-custo'), async (req, res) => {
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
app.get('/api/dre/formas-pagamento', auth, permitirPaginas('formas-pagamento-rel'), async (req, res) => {
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
app.get('/api/dre', auth, permitirPaginas('dashboard'), async (req, res) => {
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

// ── DOCUMENTOS (substitui a importação de planilha) ──────────────────────────
// 3 tipos: contrato de parceiro, nota fiscal, contrato de fornecedor. Cada
// documento é um arquivo em disco + registro no banco com o vínculo opcional
// a um parceiro/fornecedor. Mesmo padrão de upload usado em Parceiros/Perfil.
const DOCUMENTOS_UPLOAD_DIR = path.join(__dirname, 'uploads', 'documentos');
fs.mkdirSync(DOCUMENTOS_UPLOAD_DIR, { recursive: true });
const uploadDocumento = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DOCUMENTOS_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});
const TIPOS_DOCUMENTO = ['contrato_parceiro', 'nota_fiscal', 'contrato_fornecedor'];

app.get('/api/documentos', auth, permitirPaginas('import'), async (req, res) => {
  try {
    const tipo = req.query.tipo;
    if (tipo && !TIPOS_DOCUMENTO.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    let sql = `
      SELECT d.*, p.nome AS parceiro_nome, f.nome AS fornecedor_nome
      FROM documentos d
      LEFT JOIN parceiros    p ON p.id = d.parceiro_id
      LEFT JOIN fornecedores f ON f.id = d.fornecedor_id
      WHERE 1=1`;
    const params = [];
    if (tipo) { sql += ' AND d.tipo=?'; params.push(tipo); }
    sql += ' ORDER BY d.created_at DESC';
    res.json(await q(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/documentos', auth, permitirPaginas('import'), uploadDocumento.single('arquivo'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!TIPOS_DOCUMENTO.includes(b.tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });
    const result = await q(
      `INSERT INTO documentos (tipo, parceiro_id, fornecedor_id, descricao, arquivo_path, arquivo_nome, user_id)
       VALUES (?,?,?,?,?,?,?)`,
      [
        b.tipo,
        b.parceiro_id ? Number(b.parceiro_id) : null,
        b.fornecedor_id ? Number(b.fornecedor_id) : null,
        (b.descricao || '').trim() || null,
        `/uploads/documentos/${req.file.filename}`,
        req.file.originalname,
        req.user.id,
      ]
    );
    await logAction(req, 'create', 'documentos', result.insertId, `${b.tipo}: ${req.file.originalname}`);
    res.json({ id: result.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/documentos/:id', auth, permitirPaginas('import'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await q1('SELECT * FROM documentos WHERE id=?', [id]);
    await q('DELETE FROM documentos WHERE id=?', [id]);
    if (row && row.arquivo_path) fs.unlink(path.join(__dirname, row.arquivo_path.replace(/^\//, '')), () => {});
    await logAction(req, 'delete', 'documentos', id, row ? row.arquivo_nome : null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EXPORT EXCEL ──────────────────────────────────────────────────────────────
app.get('/api/export/excel', auth, permitirPaginas('import'), async (req, res) => {
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

app.get('/api/export/csv', auth, permitirPaginas('import'), async (req, res) => {
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

app.get('/api/export/xml', auth, permitirPaginas('import'), async (req, res) => {
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

app.get('/api/export/pdf', auth, permitirPaginas('import'), async (req, res) => {
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

// ── CADASTROS: PARCEIROS (com anexos de foto/contrato) ───────────────────────
// Fora do CRUD genérico porque precisa de multipart/form-data (upload.fields)
// em vez de JSON, além de gerenciar arquivo antigo/novo no disco.
const PARCEIRO_CAMPOS_OBRIGATORIOS = ['nome', 'cnpj', 'razao_social', 'responsavel', 'contato'];
// Reforça no servidor que a comissão (valor em R$) nunca seja negativa.
const clampComissao = v => Math.max(0, Number(v) || 0);

app.get('/api/parceiros', auth, permitirPaginas('cad-parceiros'), async (req, res) => {
  try { res.json(await q('SELECT * FROM parceiros ORDER BY id DESC')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/parceiros', auth, permitirPaginas('cad-parceiros'), uploadParceiro.fields([{ name: 'foto', maxCount: 1 }, { name: 'contrato', maxCount: 1 }]), async (req, res) => {
  try {
    const b = req.body;
    for (const f of PARCEIRO_CAMPOS_OBRIGATORIOS) {
      if (!b[f] || !String(b[f]).trim()) return res.status(400).json({ error: `Campo obrigatório: ${f}` });
    }
    const foto     = req.files && req.files.foto && req.files.foto[0];
    const contrato = req.files && req.files.contrato && req.files.contrato[0];

    const result = await q(
      `INSERT INTO parceiros
         (nome, razao_social, cnpj, email, endereco, comissao, contato, whatsapp, responsavel,
          foto_path, foto_nome, contrato_path, contrato_nome)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        b.nome.trim(), b.razao_social.trim(), b.cnpj.trim(), (b.email || '').trim() || null,
        (b.endereco || '').trim() || null, clampComissao(b.comissao),
        b.contato.trim(), (b.whatsapp || '').trim() || null, b.responsavel.trim(),
        foto     ? `/uploads/parceiros/${foto.filename}`     : null, foto     ? foto.originalname     : null,
        contrato ? `/uploads/parceiros/${contrato.filename}` : null, contrato ? contrato.originalname : null,
      ]
    );
    await logAction(req, 'create', 'parceiros', result.insertId, b.nome);
    res.json({ id: result.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/parceiros/:id', auth, permitirPaginas('cad-parceiros'), uploadParceiro.fields([{ name: 'foto', maxCount: 1 }, { name: 'contrato', maxCount: 1 }]), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b  = req.body;
    for (const f of PARCEIRO_CAMPOS_OBRIGATORIOS) {
      if (!b[f] || !String(b[f]).trim()) return res.status(400).json({ error: `Campo obrigatório: ${f}` });
    }
    const atual = await q1('SELECT * FROM parceiros WHERE id=?', [id]);
    if (!atual) return res.status(404).json({ error: 'Parceiro não encontrado' });

    const foto     = req.files && req.files.foto && req.files.foto[0];
    const contrato = req.files && req.files.contrato && req.files.contrato[0];

    // Se um novo anexo veio, apaga o antigo do disco (best-effort).
    if (foto && atual.foto_path) fs.unlink(path.join(__dirname, atual.foto_path.replace(/^\//, '')), () => {});
    if (contrato && atual.contrato_path) fs.unlink(path.join(__dirname, atual.contrato_path.replace(/^\//, '')), () => {});

    await q(
      `UPDATE parceiros SET
         nome=?, razao_social=?, cnpj=?, email=?, endereco=?, comissao=?, contato=?, whatsapp=?, responsavel=?,
         foto_path=?, foto_nome=?, contrato_path=?, contrato_nome=?
       WHERE id=?`,
      [
        b.nome.trim(), b.razao_social.trim(), b.cnpj.trim(), (b.email || '').trim() || null,
        (b.endereco || '').trim() || null, clampComissao(b.comissao),
        b.contato.trim(), (b.whatsapp || '').trim() || null, b.responsavel.trim(),
        foto     ? `/uploads/parceiros/${foto.filename}`     : atual.foto_path,
        foto     ? foto.originalname                          : atual.foto_nome,
        contrato ? `/uploads/parceiros/${contrato.filename}` : atual.contrato_path,
        contrato ? contrato.originalname                      : atual.contrato_nome,
        id,
      ]
    );
    await logAction(req, 'update', 'parceiros', id, b.nome);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/parceiros/:id', auth, permitirPaginas('cad-parceiros'), async (req, res) => {
  try {
    const id  = Number(req.params.id);
    const row = await q1('SELECT * FROM parceiros WHERE id=?', [id]);
    await q('DELETE FROM parceiros WHERE id=?', [id]);
    if (row) {
      if (row.foto_path)     fs.unlink(path.join(__dirname, row.foto_path.replace(/^\//, '')), () => {});
      if (row.contrato_path) fs.unlink(path.join(__dirname, row.contrato_path.replace(/^\//, '')), () => {});
    }
    await logAction(req, 'delete', 'parceiros', id, row ? row.nome : null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CADASTROS CRUD GENÉRICO ───────────────────────────────────────────────────
// paginaKey: quando informado, exige que o usuário (não-admin) tenha essa tela
// liberada em permissoes; null deixa a rota aberta a qualquer autenticado
// (caso de centros_custo, que não tem tela própria — só é lido via /api/cadastros).
function crudRoutes(table, requiredFields = [], paginaKey = null) {
  const perm = paginaKey ? [permitirPaginas(paginaKey)] : [];

  app.get(`/api/${table}`, auth, ...perm, async (req, res) => {
    try { res.json(await q(`SELECT * FROM \`${table}\` ORDER BY id`)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post(`/api/${table}`, auth, ...perm, async (req, res) => {
    try {
      const b = req.body;
      for (const f of requiredFields) if (!b[f]) return res.status(400).json({ error: `Campo obrigatório: ${f}` });
      const keys   = Object.keys(b).filter(k => b[k] !== undefined);
      const vals   = keys.map(k => b[k]);
      const result = await q(
        `INSERT INTO \`${table}\` (${keys.map(k => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
        vals
      );
      await logAction(req, 'create', table, result.insertId, b.nome || b.grupo || null);
      res.json({ id: result.insertId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put(`/api/${table}/:id`, auth, ...perm, async (req, res) => {
    try {
      const b    = req.body;
      const id   = Number(req.params.id);
      const keys = Object.keys(b).filter(k => b[k] !== undefined);
      if (!keys.length) return res.json({ ok: true });
      await q(
        `UPDATE \`${table}\` SET ${keys.map(k => `\`${k}\`=?`).join(',')} WHERE id=?`,
        [...keys.map(k => b[k]), id]
      );
      await logAction(req, 'update', table, id, b.nome || b.grupo || null);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete(`/api/${table}/:id`, auth, ...perm, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const row = await q1(`SELECT * FROM \`${table}\` WHERE id=?`, [id]);
      await q(`DELETE FROM \`${table}\` WHERE id=?`, [id]);
      await logAction(req, 'delete', table, id, row ? (row.nome || row.grupo || null) : null);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

crudRoutes('clientes',          ['nome'],  'cad-clientes');
crudRoutes('fornecedores',      ['nome'],  'cad-fornecedores');
crudRoutes('contas_receita',    ['grupo'], 'cad-contas');
crudRoutes('contas_despesa',    ['grupo'], 'cad-contas');
crudRoutes('centros_custo',     ['nome']);
crudRoutes('caixas',            ['nome'],  'cad-caixas');
crudRoutes('formas_pagamento',  ['nome'],  'cad-formas');

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
  try {
    const rows = await q('SELECT id, username, role, nome, foto_path, permissoes, created_at FROM users ORDER BY id');
    res.json(rows.map(u => {
      let permissoes = [];
      try { permissoes = JSON.parse(u.permissoes || '[]'); } catch { permissoes = []; }
      return { ...u, permissoes };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cadastro interno de usuários: só um admin autenticado pode criar novos acessos.
// Não mexe no cookie de sessão de quem está criando (o admin continua logado).
// Se o novo usuário não for admin, o admin escolhe quais telas ele acessa
// (permissoes); admin sempre tem acesso total, então a lista é ignorada nesse caso.
app.post('/api/users', auth, adminOnly, rateLimit('create-user', 20, 10 * 60 * 1000), async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    const err = validCredentials(username, password);
    if (err) return res.status(400).json({ error: err });
    const existing = await q1('SELECT id FROM users WHERE username=?', [username]);
    if (existing) return res.status(400).json({ error: 'Usuário já existe' });
    const finalRole = role === 'admin' ? 'admin' : 'user';
    const permissoes = finalRole === 'admin' ? [] : sanitizarPermissoes(req.body.permissoes);
    const hash = await bcrypt.hash(password, 10);
    const result = await q(
      'INSERT INTO users (username, password, role, permissoes) VALUES (?,?,?,?)',
      [username, hash, finalRole, finalRole === 'admin' ? null : JSON.stringify(permissoes)]
    );
    await logAction(req, 'create', 'users', result.insertId, `${username} (${finalRole})`);
    res.json({ id: result.insertId, username, role: finalRole, permissoes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:id/role', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await q('UPDATE users SET role=? WHERE id=?', [req.body.role, id]);
    await logAction(req, 'update_role', 'users', id, `nova função: ${req.body.role}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edição completa de um usuário já existente: usuário, função, permissões e,
// opcionalmente, redefinir a senha (campo vazio = mantém a senha atual).
app.put('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const atual = await q1('SELECT * FROM users WHERE id=?', [id]);
    if (!atual) return res.status(404).json({ error: 'Usuário não encontrado' });

    const { username, role, password } = req.body || {};
    if (!username || !String(username).trim()) return res.status(400).json({ error: 'Usuário é obrigatório' });
    const dono = await q1('SELECT id FROM users WHERE username=? AND id<>?', [username.trim(), id]);
    if (dono) return res.status(400).json({ error: 'Usuário já existe' });

    const finalRole = role === 'admin' ? 'admin' : 'user';
    const permissoes = finalRole === 'admin' ? [] : sanitizarPermissoes(req.body.permissoes);

    let senhaHash = atual.password;
    if (password && password.trim()) {
      if (password.trim().length < 4) return res.status(400).json({ error: 'A senha deve ter ao menos 4 caracteres' });
      senhaHash = await bcrypt.hash(password.trim(), 10);
    }

    await q(
      'UPDATE users SET username=?, role=?, password=?, permissoes=? WHERE id=?',
      [username.trim(), finalRole, senhaHash, finalRole === 'admin' ? null : JSON.stringify(permissoes), id]
    );
    await logAction(req, 'update', 'users', id, `${username.trim()} (${finalRole})`);
    res.json({ id, username: username.trim(), role: finalRole, permissoes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Não pode deletar a si mesmo' });
    const row = await q1('SELECT username, role FROM users WHERE id=?', [id]);
    await q('DELETE FROM users WHERE id=?', [id]);
    await logAction(req, 'delete', 'users', id, row ? `${row.username} (${row.role})` : null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LOGS ──────────────────────────────────────────────────────────────────────
// Só admin acessa. Filtros opcionais por ação, usuário e período; paginado.
app.get('/api/logs', auth, adminOnly, async (req, res) => {
  try {
    const { action, username, from, to, page = '1', limit = '50' } = req.query;
    const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const pg  = Math.max(parseInt(page) || 1, 1);
    const off = (pg - 1) * lim;

    let sql = 'SELECT * FROM logs WHERE 1=1';
    let countSql = 'SELECT COUNT(*) as n FROM logs WHERE 1=1';
    const p = [];
    if (action)   { sql += ' AND action=?';           countSql += ' AND action=?';           p.push(action); }
    if (username) { sql += ' AND username LIKE ?';    countSql += ' AND username LIKE ?';     p.push(`%${username}%`); }
    if (from)     { sql += ' AND created_at>=?';       countSql += ' AND created_at>=?';       p.push(from); }
    if (to)       { sql += ' AND created_at<=?';       countSql += ' AND created_at<=?';       p.push(to + ' 23:59:59'); }

    const [{ n }] = await q(countSql, p);
    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    const rows = await q(sql, [...p, lim, off]);
    res.json({ rows, total: n, page: pg, limit: lim, pages: Math.max(Math.ceil(n / lim), 1) });
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
