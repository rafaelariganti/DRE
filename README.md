# DRE System — OAF 2026

Sistema de Controle Financeiro (DRE) — agora com MySQL.

---

## ⚙️ Configuração do Banco de Dados

### 1. Instale o MySQL
Baixe em: https://dev.mysql.com/downloads/mysql/

### 2. Configure o arquivo `.env`
Copie o arquivo `.env.example` para `.env`:
```
cp .env.example .env
```

Edite o `.env` com suas credenciais:
```
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASS=sua_senha_aqui
DB_NAME=dre_oaf
```

> O sistema cria o banco `dre_oaf` automaticamente na primeira execução.
> Não é necessário rodar nenhum script SQL manualmente.

---

## 🚀 Instalação e Execução

```bash
# Instale as dependências
npm install

# Inicie o servidor
npm start
```

Acesse: http://localhost:3000

---

## 📦 Migração de dados antigos (dre.json)

Se você tinha dados no arquivo `db/dre.json`, eles serão migrados
automaticamente para o MySQL na primeira inicialização.
O arquivo original será renomeado para `dre.json.bak`.

---

## 🗄️ Estrutura do Banco

Tabelas criadas automaticamente:

| Tabela             | Descrição                        |
|--------------------|----------------------------------|
| users              | Usuários do sistema              |
| clientes           | Cadastro de clientes             |
| fornecedores       | Cadastro de fornecedores         |
| centros_custo      | Centros de custo                 |
| caixas             | Contas caixa/banco               |
| formas_pagamento   | Formas de pagamento              |
| contas_receita     | Grupos/contas de receita         |
| contas_despesa     | Grupos/contas de despesa         |
| transactions       | Lançamentos (receitas/despesas)  |
| transfers          | Transferências entre caixas      |
| imported_sheets    | Planilhas importadas             |
| imported_rows      | Linhas das planilhas importadas  |

---

## 🔐 Primeiro Acesso

1. Acesse http://localhost:3000
2. Clique em **Criar conta**
3. O **primeiro usuário** cadastrado recebe perfil `admin` automaticamente
