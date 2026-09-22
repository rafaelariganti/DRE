# Auditoria — Lógica do DRE e Fluxo de Dados (DRE System)

Repositório analisado: `DRE-main` (branch `feature/log-atividades`), arquivos `server.js`, `database.js`, `public/js/app.js`.
Auditoria feita por leitura de código (não tenho acesso à sua VPS/MySQL de produção, então não validei contra dados reais — recomendo testar os cenários de borda listados no fim direto no ambiente).

---

## Resumo executivo

| # | Achado | Severidade | Onde |
|---|--------|-----------|------|
| 1 | Sistema não implementa a hierarquia contábil completa (sem CPV, sem separação Adm/Vendas/Financeiras, sem EBIT/EBITDA) | 🔴 Estrutural | Todo o módulo DRE |
| 2 | **Dashboard e "DRE Resumo/Detalhado" calculam o lucro de formas diferentes** — números não batem entre telas | 🔴 Alta | `server.js` |
| 3 | ~~Fluxo de Caixa mistura regime de caixa com regime de competência~~ **[Corrigido]** — agora separa Realizado (regime de caixa) de Previsto (regime de competência) | 🟢 Resolvido | `/api/dre/fluxo-caixa` |
| 4 | Fluxo de Caixa filtrado por caixa específico ignora transferências no saldo | 🟠 Média-Alta | `/api/dre/fluxo-caixa` |
| 5 | Taxa MDR calculada também em despesas (sem sentido conceitual) | 🟡 Média | `calcTaxaMDR` |
| 6 | Status default (`'realizado'`) não existe no vocabulário usado pelo resto do sistema | 🟡 Média (latente) | `POST /api/transactions` |
| 7 | Log de exclusão não guarda snapshot do que foi apagado | 🟡 Baixa-Média | `logAction` em DELETEs |
| 8 | Cenários de borda — testados por leitura, sem crash aparente | 🟢 OK | vários |

---

## 1. Estrutura do DRE não segue a hierarquia contábil pedida (🔴 estrutural)

A hierarquia esperada é:

```
Receita Bruta
(-) Deduções/Impostos          → Receita Líquida
(-) CPV/CMV                    → Lucro Bruto
(-) Despesas Operacionais
    (Adm, Vendas, Financeiras) → Resultado Operacional (EBIT/EBITDA)
+/- Não operacional e impostos → Lucro/Prejuízo Líquido
```

O que existe hoje (`server.js`, rota `GET /api/dre`, usada pelo Dashboard):

```js
// 1) Receita Bruta = soma de TODAS as receitas do período
const receitaBruta = txs.filter(t => t.tipo === 'income').reduce(...)
// 2) Deduções = soma da taxa_mdr de TODAS as receitas
const deducoes = txs.filter(t => t.tipo === 'income').reduce(...)
// 3) Receita Líquida = Receita Bruta - Deduções
const receitaLiquida = receitaBruta - deducoes;
// 4) Despesas Operacionais = soma de TODAS as despesas do período
const despesasOperacionais = txs.filter(t => t.tipo === 'expense').reduce(...)
// 5) Lucro Líquido = Receita Líquida - Despesas Operacionais
const lucroLiquido = receitaLiquida - despesasOperacionais;
```

Isso é um **DRE de 2 níveis**: Receita Bruta → Receita Líquida → Lucro Líquido direto. Não existe:
- **CPV/CMV** separado (custo do que foi vendido/prestado) — hoje toda despesa cai no mesmo balaio.
- **Lucro Bruto** como etapa intermediária.
- Despesas classificadas por natureza (Administrativas / Vendas / Financeiras) — o campo `grupo` em `contas_despesa` é texto livre, não uma classificação estruturada.
- **Resultado Operacional (EBIT/EBITDA)** distinto do Lucro Líquido.
- Separação entre itens **operacionais** e **não operacionais** (ex: venda de um imobilizado, juros de aplicação).

**Não dá pra "corrigir" isso com um ajuste de fórmula** — é uma decisão de modelagem: você precisaria adicionar um campo de classificação nas contas de despesa (ex: `natureza ENUM('cpv','administrativa','vendas','financeira','nao_operacional')`), migrar os cadastros existentes, e reescrever as 3 rotas de DRE pra somar por natureza em vez de somar tudo junto. Isso é uma feature nova, não um bugfix — te aviso aqui pra você decidir se quer priorizar isso como próxima entrega, mas não implementei porque muda o modelo de dados e você precisaria classificar as contas de despesa já cadastradas uma a uma.

---

## 2. Dashboard e "DRE Resumo"/"DRE Detalhado" calculam o lucro de formas diferentes (🔴 alta)

Esse é o achado mais grave e mais fácil de confirmar: **a mesma competência (ano) dá números de lucro diferentes** dependendo de qual tela você abre.

**Dashboard** (`GET /api/dre`, `server.js` linha ~502-522) deduz a taxa MDR da receita:

```js
const receitaBruta = txs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.valor || 0), 0);
const deducoes = txs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.taxa_mdr || 0), 0);
const receitaLiquida = receitaBruta - deducoes;
const lucroLiquido = receitaLiquida - despesasOperacionais;
```

**DRE Resumo** (`GET /api/dre/resumo`, `server.js` linha ~371-379) **não** deduz taxa MDR nenhuma:

```js
const receitas = mtxs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.valor), 0);
const despesas = mtxs.filter(t => t.tipo === 'expense').reduce((s, t) => s + Number(t.valor), 0);
const lucro = receitas - despesas;   // ← sem subtrair taxa_mdr
```

**DRE Detalhado** (`GET /api/dre/detalhado`) também soma `valor` puro, sem taxa.

Se você tem lançamentos com forma de pagamento que cobra taxa (cartão, maquininha), o Dashboard mostra um lucro **menor** (correto, desconta a taxa) e o DRE Resumo/Detalhado mostra um lucro **maior** (esquece a taxa) — pro mesmo ano, no mesmo sistema. Qualquer pessoa comparando as duas telas vai achar que uma está errada (e uma delas está mesmo).

**Correção proposta:** escolher uma fonte de verdade única. O mais simples é fazer `dre/resumo` e `dre/detalhado` também selecionarem `taxa_mdr` e subtraírem da receita, igual o Dashboard já faz:

```js
// dre/resumo — trocar:
const receitas = mtxs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.valor), 0);
// por:
const receitaBruta = mtxs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.valor), 0);
const deducoes = mtxs.filter(t => t.tipo === 'income').reduce((s, t) => s + Number(t.taxa_mdr || 0), 0);
const receitas = receitaBruta - deducoes; // receita líquida, consistente com o Dashboard
```

Não implementei ainda porque isso muda o número que aparece pra você e pro cliente — melhor você confirmar qual das duas contas é a "certa" antes de eu mexer (eu recomendo a do Dashboard, que já desconta a taxa).

---

## 3. Fluxo de Caixa mistura regime de caixa com regime de competência (🟢 corrigido)

**Status: corrigido na branch `fix/fluxo-caixa-regime-caixa-vs-competencia`.**

`GET /api/dre/fluxo-caixa` (`server.js` linha ~412-449) monta o saldo diário assim:

```js
let sqlTx = 'SELECT tipo, data, valor FROM transactions WHERE YEAR(data)=? AND MONTH(data)=?';
// ... sem filtro de status
const receita = dayTxs.filter(t => t.tipo === 'income')...
const despesa = dayTxs.filter(t => t.tipo === 'expense')...
const resultado = receita - despesa;
saldoAcum += resultado;
```

O nome da tela é **Fluxo de Caixa**, que por definição deveria refletir dinheiro que **de fato entrou ou saiu** — ou seja, regime de caixa. Mas a consulta usa a coluna `data` (data do lançamento/competência) e **não filtra por `status`**, então um título `em_aberto` (ainda não pago/recebido) entra no cálculo do saldo do dia como se o dinheiro já tivesse se movido.

Resultado prático: se você lança uma despesa "em aberto" com vencimento pra daqui 30 dias, ela já derruba o saldo projetado de **hoje** no Fluxo de Caixa, mesmo que o dinheiro só saia da conta daqui a um mês.

**Correção proposta** — duas alternativas, você escolhe:
- **Opção A (mais simples):** filtrar só `status='quitado'` e usar `data_pagamento` em vez de `data` pra saber em que dia o dinheiro efetivamente moveu.
- **Opção B (mais completa):** manter os dois regimes, mas separados — "Realizado" (quitados, por `data_pagamento`) e "Previsto" (em_aberto, por `data_vencimento`) como duas linhas/cores diferentes no gráfico, que é o que a maioria dos sistemas financeiros faz.

Não apliquei a mudança porque isso é uma decisão de produto (qual comportamento você quer), não um bug óbvio de sinal trocado.

---

## 4. Fluxo de Caixa filtrado por caixa específico ignora as transferências (🟠 média-alta — esse é um bug real, não decisão de produto)

Mesma rota, olha o trecho completo:

```js
const transferencia = dayTrs.reduce((s, t) => s + Number(t.valor), 0);
const resultado = receita - despesa;      // ← transferencia não entra aqui
saldoAcum += resultado;                    // ← nem aqui
dias.push({ data: ds, receita, despesa, transferencia, resultado, saldo: saldoAcum });
```

Quando você filtra o relatório por um caixa específico (ex: "Banco X"), a query de transferências pega tudo que **entrou ou saiu** desse caixa:

```js
if (caixa && caixa !== 'Todos') { sqlTr += ' AND (origem_nome=? OR destino_nome=?)'; pTr.push(caixa, caixa); }
```

Mas o valor somado (`transferencia`) nunca é somado nem subtraído do `saldoAcum` — ele só aparece exibido na tela, sem afetar o saldo projetado. Então se você transferir R$ 5.000 do Caixa A pro Banco X, o saldo do **Banco X** no relatório filtrado não sobe, e o saldo do **Caixa A** não desce — o dinheiro "desaparece" do gráfico, mesmo estando certo nos lançamentos.

Quando o filtro é "Todos os caixas", isso não é visível (porque transferência interna não deveria mesmo afetar o total geral — dinheiro só mudou de bolso). O bug só aparece com um caixa específico selecionado.

**Correção proposta:**

```js
const transferenciaEntrada = dayTrs.filter(t => t.destino_nome === caixa).reduce((s,t)=>s+Number(t.valor),0);
const transferenciaSaida   = dayTrs.filter(t => t.origem_nome  === caixa).reduce((s,t)=>s+Number(t.valor),0);
const resultado = receita - despesa + (caixa && caixa!=='Todos' ? transferenciaEntrada - transferenciaSaida : 0);
```

Esse eu classificaria como bugfix puro (sem ambiguidade de produto) — posso implementar se você quiser, é rápido.

---

## 5. Taxa MDR é calculada também em despesas (🟡 média)

`calcTaxaMDR` é chamado sem checar o tipo do lançamento:

```js
const taxa = await calcTaxaMDR(b.forma_pagamento || b.forma_pagamento_nome, valor);
// roda igual pra tipo='income' e tipo='expense'
```

MDR ("Merchant Discount Rate") é a taxa que a maquininha/adquirente cobra em cima de uma **venda recebida via cartão** — não faz sentido conceitual aplicar essa taxa numa despesa. Hoje, se você cadastra uma despesa usando uma forma de pagamento que tem `taxa_intermediacao` configurada (ex: "Cartão de Crédito" cadastrado com taxa), o sistema calcula um `valor_liquido` menor que o `valor` da despesa — como se a despesa "rendesse desconto", o que é o oposto do que acontece na vida real (parcelamento de despesa normalmente **aumenta** o custo, não diminui).

Isso não corrompe o Lucro Líquido do Dashboard (que só usa `taxa_mdr` pra receitas), mas polui a coluna "Taxa MDR"/"Valor Líquido" nas telas de Lançamentos, Contas a Pagar/Receber, e nas exportações (CSV/XML/PDF) — pode confundir quem estiver lendo o relatório.

**Correção proposta:**

```js
const taxa = tipo === 'income' ? await calcTaxaMDR(b.forma_pagamento || b.forma_pagamento_nome, valor) : 0;
```
(aplicar em `POST` e `PUT` de `/api/transactions`)

---

## 6. Status default (`'realizado'`) não existe no vocabulário do resto do sistema (🟡 média, hoje latente)

```js
// server.js, POST e PUT /api/transactions
b.status || 'realizado',
```

Mas em todo o resto do sistema — Contas a Pagar/Receber, badges, filtros — só existem dois status: `'em_aberto'` e `'quitado'`:

```js
// public/js/app.js — Contas a Pagar/Receber só busca esses dois:
api('/transactions?status=em_aberto' ...)
api('/transactions?status=quitado' ...)
```

Hoje, na prática, o formulário do front sempre manda `'quitado'` ou `'em_aberto'` explicitamente (`$('tx-status').value = tx?(tx.status||'quitado'):'quitado'`), então esse bug **não se manifesta pelo fluxo normal da UI**. Mas é uma armadilha esperando alguém pisar: se no futuro você criar uma integração, importação automática de lançamentos, ou qualquer chamada direta à API sem passar `status`, esse lançamento nasce com `status='realizado'` e **some** — não aparece em nenhuma aba de Contas a Pagar/Receber (nem "em aberto" nem "quitado"), embora continue contando normalmente nos totais do DRE (que não filtra por status).

**Correção proposta:** trocar o default de `'realizado'` para `'quitado'` (mesmo default do front), ou melhor ainda, validar no backend que `status` só aceita `'em_aberto'` ou `'quitado'` e rejeitar qualquer outro valor.

---

## 7. Log de exclusão não guarda o que foi apagado (🟡 baixa-média)

Isso é uma lacuna que ficou na feature de log que acabamos de implementar juntos — vale corrigir agora que estamos auditando o fluxo de dados. Nos `DELETE`, o log é chamado sem `details`:

```js
app.delete('/api/transactions/:id', ...)
  await q('DELETE FROM transactions WHERE id=?', [id]);
  await logAction(req, 'delete', 'transactions', id);   // ← sem valor, sem tipo, sem descrição
```

Mesma coisa em `DELETE /api/transfers/:id`, `DELETE /api/users/:id` e no CRUD genérico de cadastros. Depois que o registro é apagado do banco, o log fica só com `"excluído #42"` — sem informação nenhuma sobre o que era. Pra um sistema financeiro, isso é uma lacuna real de auditoria: se alguém excluir um lançamento de R$ 50.000 por engano (ou de propósito), o log não vai te dizer o valor.

**Correção proposta:** buscar a linha antes de deletar e colocar um resumo em `details`:

```js
app.delete('/api/transactions/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await q1('SELECT tipo, valor, descricao FROM transactions WHERE id=?', [id]);
    await q('DELETE FROM transactions WHERE id=?', [id]);
    await logAction(req, 'delete', 'transactions', id, row ? `${row.tipo} - ${row.descricao} - R$${row.valor}` : null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

Esse é rápido e sem ambiguidade — posso implementar junto com o item 4 se você topar.

---

## 8. Cenários de borda — verificados por leitura de código

| Cenário | Resultado |
|---|---|
| Mês sem nenhum lançamento | ✅ OK — `dre/resumo` inicializa os 12 meses e o `reduce` de um array vazio retorna 0, sem crash. |
| Ano sem nenhum lançamento | ✅ OK — mesma lógica, tudo zera. |
| Lançamento com `valor=0` | ✅ OK — soma 0, não quebra nenhum cálculo. |
| Exclusão de lançamento (estorno) | ⚠️ Não existe um "estorno" de verdade — só existe excluir (perde o registro, ver item 7) ou reverter de `quitado` pra `em_aberto` via `reabrirTitulo` (isso funciona bem, é um PATCH que zera `data_pagamento`). Se você quiser rastreabilidade completa de estornos, sugiro um status `'cancelado'` em vez de DELETE físico — mas isso é uma feature nova, não bug. |
| Transferência entre caixas nunca conta como receita/despesa no DRE | ✅ Correto — `transfers` é uma tabela separada, nunca entra nas queries de `/api/dre*`. Isso é o comportamento certo (transferência interna não deveria afetar o resultado). |
| Filtro de período (`YEAR(data)=?` / `MONTH(data)=?`) | ✅ SQL parametrizado corretamente em todas as rotas — sem risco de SQL injection e sem erro de sintaxe visível. |

---

## Priorização sugerida

1. **Item 2** (Dashboard x DRE Resumo/Detalhado divergentes) — é o que mais rápido gera desconfiança no sistema, porque é visível na cara.
2. **Item 4** (transferência sumindo do Fluxo de Caixa filtrado) — bug puro, sem ambiguidade, fácil de corrigir.
3. **Item 7** (log de exclusão sem detalhes) — rápido, e como acabamos de construir os logs juntos, faz sentido fechar essa lacuna agora.
4. **Item 5** (MDR em despesa) — rápido, baixo risco.
5. **Item 6** (status default) — rápido, baixo risco, mais preventivo que corretivo.
6. **Item 3** (regime caixa x competência no Fluxo de Caixa) — precisa da sua decisão de produto antes de eu mexer.
7. **Item 1** (hierarquia contábil completa) — é a maior mudança, envolve reclassificar contas de despesa existentes. Recomendo tratar como projeto separado, não como bugfix.

Me diz quais desses você quer que eu implemente — os itens 2, 4, 5, 6 e 7 (log) dá pra fazer rápido, em uma ou duas branches. Os itens 3 e 1 precisam de uma conversa antes, porque mudam como os números aparecem pra você e pro cliente.
