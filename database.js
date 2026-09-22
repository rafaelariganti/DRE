/**
 * database.js — MySQL via mysql2/promise
 * Compatível com MySQL 5.7, 8.0, 8.4+ e MariaDB.
 *
 * Configuração: edite as variáveis abaixo ou crie um arquivo .env na raiz.
 */

const mysql = require('mysql2/promise');
const path  = require('path');
const fs    = require('fs');

// ─── Carrega .env simples se existir ────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}

// ─── Config do banco ─────────────────────────────────────────────────────────
const DB_CONFIG = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 3306),
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASS     || '',
  database: process.env.DB_NAME     || 'dre_oaf',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  timezone: '-03:00',
};

let pool = null;

async function initDb() {
  // 1) Cria o schema se não existir (conecta sem database primeiro)
  const adminConn = await mysql.createConnection({
    host:     DB_CONFIG.host,
    port:     DB_CONFIG.port,
    user:     DB_CONFIG.user,
    password: DB_CONFIG.password,
    charset:  'utf8mb4',
  });
  await adminConn.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await adminConn.end();

  // 2) Cria pool com o banco
  pool = mysql.createPool(DB_CONFIG);

  // 3) Cria tabelas
  await criarTabelas();

  // 3b) Migra colunas novas em tabelas já existentes (perfil de usuário)
  await migrarColunasUsers();

  // 4) Seed inicial
  await seedDados();

  console.log(`[DB] MySQL conectado → ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  return pool;
}

async function criarTabelas() {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS=0');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        username   VARCHAR(100) NOT NULL UNIQUE,
        password   VARCHAR(255) NOT NULL,
        role       ENUM('admin','user') DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        nome        VARCHAR(255) NOT NULL,
        cnpj_cpf    VARCHAR(30),
        estado      VARCHAR(50),
        cidade      VARCHAR(100),
        endereco    VARCHAR(255),
        telefone    VARCHAR(30),
        email       VARCHAR(150),
        observacoes TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS fornecedores (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        nome        VARCHAR(255) NOT NULL,
        cnpj_cpf    VARCHAR(30),
        estado      VARCHAR(50),
        cidade      VARCHAR(100),
        endereco    VARCHAR(255),
        telefone    VARCHAR(30),
        email       VARCHAR(150),
        observacoes TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS parceiros (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        nome          VARCHAR(255) NOT NULL,
        razao_social  VARCHAR(255) NOT NULL,
        cnpj          VARCHAR(30) NOT NULL,
        email         VARCHAR(150),
        endereco      VARCHAR(255),
        comissao      DECIMAL(8,2) DEFAULT 0,
        contato       VARCHAR(150) NOT NULL,
        whatsapp      VARCHAR(30),
        responsavel   VARCHAR(150) NOT NULL,
        foto_path     VARCHAR(255),
        foto_nome     VARCHAR(255),
        contrato_path VARCHAR(255),
        contrato_nome VARCHAR(255),
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS centros_custo (
        id   INT AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(150) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS caixas (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        nome          VARCHAR(100) NOT NULL,
        saldo_inicial DECIMAL(15,2) DEFAULT 0.00
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS formas_pagamento (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        nome                VARCHAR(100) NOT NULL,
        parcelas            INT DEFAULT 1,
        dias_recebimento    INT DEFAULT 0,
        taxa_intermediacao  DECIMAL(8,4) DEFAULT 0,
        taxa_parcelamento   DECIMAL(8,4) DEFAULT 0,
        tarifa_fixa         DECIMAL(10,2) DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS contas_receita (
        id    INT AUTO_INCREMENT PRIMARY KEY,
        grupo VARCHAR(150) NOT NULL,
        conta VARCHAR(150)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS contas_despesa (
        id    INT AUTO_INCREMENT PRIMARY KEY,
        grupo VARCHAR(150) NOT NULL,
        conta VARCHAR(150)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id                    INT AUTO_INCREMENT PRIMARY KEY,
        tipo                  ENUM('income','expense') NOT NULL,
        data                  DATE NOT NULL,
        descricao             VARCHAR(255),
        valor                 DECIMAL(15,2) NOT NULL,
        conta_id              INT,
        conta_nome            VARCHAR(150),
        grupo                 VARCHAR(150),
        cliente_fornecedor    VARCHAR(255),
        forma_pagamento_id    INT,
        forma_pagamento_nome  VARCHAR(100),
        caixa_id              INT,
        caixa_nome            VARCHAR(100),
        centro_custo_id       INT,
        centro_custo_nome     VARCHAR(150),
        status                VARCHAR(30) DEFAULT 'realizado',
        data_vencimento       DATE,
        data_pagamento        DATE,
        taxa_mdr              DECIMAL(15,2) DEFAULT 0,
        valor_liquido         DECIMAL(15,2),
        observacoes           TEXT,
        user_id               INT,
        created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS transfers (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        data         DATE NOT NULL,
        descricao    VARCHAR(255),
        valor        DECIMAL(15,2) NOT NULL,
        origem_id    INT,
        origem_nome  VARCHAR(100),
        destino_id   INT,
        destino_nome VARCHAR(100),
        observacoes  TEXT,
        user_id      INT,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS imported_sheets (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        filename    VARCHAR(255),
        user_id     INT,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS imported_rows (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        sheet_id   INT NOT NULL,
        sheet_name VARCHAR(100),
        row_index  INT,
        data_json  MEDIUMTEXT,
        INDEX idx_sheet (sheet_id, sheet_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Documentos: substitui a importação de planilha por upload de arquivos
    // organizados em 3 tipos (contrato de parceiro, nota fiscal, contrato de
    // fornecedor), cada um podendo linkar a um parceiro/fornecedor.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS documentos (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        tipo          ENUM('contrato_parceiro','nota_fiscal','contrato_fornecedor') NOT NULL,
        parceiro_id   INT NULL,
        fornecedor_id INT NULL,
        descricao     VARCHAR(255) NULL,
        arquivo_path  VARCHAR(255) NOT NULL,
        arquivo_nome  VARCHAR(255) NOT NULL,
        user_id       INT NULL,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_doc_tipo (tipo)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Log de atividades: registra ações relevantes (login, cadastros, lançamentos,
    // usuários) pra dar rastreabilidade de quem fez o quê e quando no sistema.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NULL,
        username   VARCHAR(100),
        action     VARCHAR(40)  NOT NULL,
        entity     VARCHAR(40)  NOT NULL,
        entity_id  INT NULL,
        details    VARCHAR(500),
        ip         VARCHAR(64),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_logs_created (created_at),
        INDEX idx_logs_user (user_id),
        INDEX idx_logs_action (action)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query('SET FOREIGN_KEY_CHECKS=1');
  } finally {
    conn.release();
  }
}

async function seedDados() {
  const conn = await pool.getConnection();
  try {
    // Centros de custo
    const [[{ n: ncc }]] = await conn.query('SELECT COUNT(*) as n FROM centros_custo');
    if (!ncc) {
      const cc = ['DESPESAS OPERACIONAIS','DESPESAS DE IMPOSTOS','DESPESAS ADMINISTRATIVAS',
                  'RECEITA OPERACIONAL','RECEITA VENDAS','RECEITA COMUM','ADMINISTRATIVO'];
      for (const nome of cc) await conn.query('INSERT INTO centros_custo (nome) VALUES (?)', [nome]);
    }

    // Caixas
    const [[{ n: ncx }]] = await conn.query('SELECT COUNT(*) as n FROM caixas');
    if (!ncx) {
      await conn.query("INSERT INTO caixas (nome, saldo_inicial) VALUES ('Itaú', 0), ('NU BANK', 0)");
    }

    // Formas de pagamento
    const [[{ n: nfp }]] = await conn.query('SELECT COUNT(*) as n FROM formas_pagamento');
    if (!nfp) {
      await conn.query(`
        INSERT INTO formas_pagamento (nome,parcelas,dias_recebimento,taxa_intermediacao,taxa_parcelamento,tarifa_fixa) VALUES
        ('CARTÃO CRÉDITO',1,30,0,1.9,0),
        ('CARTÃO DÉBITO',1,1,0,0,0),
        ('BOLETO BANCÁRIO',1,1,0,0,0),
        ('DINHEIRO',1,0,0,0,0),
        ('PIX',1,0,0,0,0),
        ('Débito',1,1,0,0,0),
        ('Crédito à vista',1,31,0,0,0),
        ('Crédito',2,31,0,0,0)
      `);
    }

    // Contas receita
    const [[{ n: ncr }]] = await conn.query('SELECT COUNT(*) as n FROM contas_receita');
    if (!ncr) {
      await conn.query(`
        INSERT INTO contas_receita (grupo, conta) VALUES
        ('PIX','Itaú'),
        ('Cartão de débito','Itaú'),
        ('Cartão de Crédito Rede Itaú','Cartão Rede (Pix-Débito-Crédito)'),
        ('Cartão de crédito','Itaú')
      `);
    }

    // Contas despesa
    const [[{ n: ncd }]] = await conn.query('SELECT COUNT(*) as n FROM contas_despesa');
    if (!ncd) {
      await conn.query(`
        INSERT INTO contas_despesa (grupo, conta) VALUES
        ('CONSULTÓRIA','CONSULTÓRIO OAF'),
        ('Prestadores de Serviço','Prestadores Direto'),
        ('Prestadores de Serviço','Prestadores Indiretos'),
        ('Consultória','Edifício Kasato Maru - 1°Andar'),
        ('Plano de Sáude','Convênio Intermédica Smart 300'),
        ('Administrativo','Estágiario'),
        ('Administrativo','Equipe de limpeza'),
        ('Repasse dos Médicos(as)','Despesa Variavel')
      `);
    }

    // Cliente padrão
    const [[{ n: ncli }]] = await conn.query('SELECT COUNT(*) as n FROM clientes');
    if (!ncli) {
      await conn.query(
        "INSERT INTO clientes (nome, cnpj_cpf, estado, cidade) VALUES ('Rede - Banco Itaú','','São Paulo','Sorocaba')"
      );
    }

    // Fornecedor padrão
    const [[{ n: nforn }]] = await conn.query('SELECT COUNT(*) as n FROM fornecedores');
    if (!nforn) {
      await conn.query(
        "INSERT INTO fornecedores (nome, cnpj_cpf) VALUES ('OAF - ODIRLEI AMARO FERREIRA','63.721.226/0001-00')"
      );
    }
  } finally {
    conn.release();
  }
}

// Migra dados do JSON legado (dre.json) para o MySQL
async function migrarLegado() {
  const jsonPath = path.join(__dirname, 'db', 'dre.json');
  if (!fs.existsSync(jsonPath)) return;

  try {
    const legacy = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const conn = await pool.getConnection();

    try {
      // Transactions
      if (Array.isArray(legacy.transactions) && legacy.transactions.length) {
        const [[{ n }]] = await conn.query('SELECT COUNT(*) as n FROM transactions');
        if (!n) {
          for (const t of legacy.transactions) {
            await conn.query(`
              INSERT INTO transactions
                (tipo,data,descricao,valor,conta_nome,grupo,cliente_fornecedor,
                 forma_pagamento_nome,caixa_nome,centro_custo_nome,status,taxa_mdr,valor_liquido,user_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [t.type||t.tipo, t.date||t.data, t.description||t.descricao, t.amount||t.valor||0,
               t.conta||t.conta_nome, t.grupo_contas||t.grupo, t.cliente_fornecedor,
               t.forma_pagamento||t.forma_pagamento_nome, t.caixa_banco||t.caixa_nome,
               t.centro_custo||t.centro_custo_nome, t.status||'realizado',
               t.taxa_mdr||0, t.valor_liquido||t.amount||t.valor||0, t.user_id||1]
            );
          }
          console.log(`[DB] ${legacy.transactions.length} transação(ões) migrada(s).`);
        }
      }

      // Transfers
      if (Array.isArray(legacy.transfers) && legacy.transfers.length) {
        const [[{ n }]] = await conn.query('SELECT COUNT(*) as n FROM transfers');
        if (!n) {
          for (const t of legacy.transfers) {
            await conn.query(`
              INSERT INTO transfers (data,descricao,valor,origem_nome,destino_nome,user_id)
              VALUES (?,?,?,?,?,?)`,
              [t.date||t.data, t.description||t.descricao, t.amount||t.valor||0,
               t.caixa_saida||t.origem_nome, t.caixa_entrada||t.destino_nome, t.user_id||1]
            );
          }
          console.log(`[DB] ${legacy.transfers.length} transferência(s) migrada(s).`);
        }
      }

      // Clientes extras
      if (Array.isArray(legacy.clientes)) {
        for (const c of legacy.clientes) {
          const [[{ n }]] = await conn.query('SELECT COUNT(*) as n FROM clientes WHERE nome=?', [c.nome]);
          if (!n) {
            await conn.query(
              'INSERT INTO clientes (nome,cnpj_cpf,estado,cidade,endereco,telefone,email,observacoes) VALUES (?,?,?,?,?,?,?,?)',
              [c.nome, c.cnpj_cpf||'', c.estado||'', c.cidade||'', c.endereco||'', c.telefone||'', c.email||'', c.observacoes||'']
            );
          }
        }
      }

      // Fornecedores extras
      if (Array.isArray(legacy.fornecedores)) {
        for (const f of legacy.fornecedores) {
          const [[{ n }]] = await conn.query('SELECT COUNT(*) as n FROM fornecedores WHERE nome=?', [f.nome]);
          if (!n) {
            await conn.query(
              'INSERT INTO fornecedores (nome,cnpj_cpf,estado,cidade,endereco,telefone,email,observacoes) VALUES (?,?,?,?,?,?,?,?)',
              [f.nome, f.cnpj_cpf||'', f.estado||'', f.cidade||'', f.endereco||'', f.telefone||'', f.email||'', f.observacoes||'']
            );
          }
        }
      }
    } finally {
      conn.release();
    }

    fs.renameSync(jsonPath, jsonPath + '.bak');
    console.log('[DB] Migração do dre.json concluída. Arquivo renomeado para dre.json.bak');
  } catch (e) {
    console.error('[DB] Erro na migração:', e.message);
  }
}

// Adiciona colunas novas na tabela users pra quem já tinha o banco criado antes
// (perfil: nome, foto, e a lista de telas liberadas pra usuários não-admin), e
// as colunas de agência bancária no cadastro de Forma de Pagamento.
async function migrarColunasUsers() {
  const conn = await pool.getConnection();
  try {
    const [existentes] = await conn.query(
      `SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME IN ('users','formas_pagamento')`,
      [DB_CONFIG.database]
    );
    const colsUsers = new Set(existentes.filter(r => r.TABLE_NAME === 'users').map(r => r.COLUMN_NAME));
    const colsFormas = new Set(existentes.filter(r => r.TABLE_NAME === 'formas_pagamento').map(r => r.COLUMN_NAME));

    if (!colsUsers.has('nome'))       await conn.query('ALTER TABLE users ADD COLUMN nome VARCHAR(150) NULL AFTER username');
    if (!colsUsers.has('foto_path'))  await conn.query('ALTER TABLE users ADD COLUMN foto_path VARCHAR(255) NULL');
    if (!colsUsers.has('foto_nome'))  await conn.query('ALTER TABLE users ADD COLUMN foto_nome VARCHAR(255) NULL');
    if (!colsUsers.has('permissoes')) await conn.query('ALTER TABLE users ADD COLUMN permissoes TEXT NULL');

    if (!colsFormas.has('banco'))    await conn.query('ALTER TABLE formas_pagamento ADD COLUMN banco VARCHAR(100) NULL');
    if (!colsFormas.has('agencia'))  await conn.query('ALTER TABLE formas_pagamento ADD COLUMN agencia VARCHAR(30) NULL');
  } finally {
    conn.release();
  }
}

function getPool() { return pool; }

module.exports = { initDb, migrarLegado, getPool };
