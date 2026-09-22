/**
 * dre-calculo.js
 * Função central de cálculo para o Dashboard e o DRE Estruturado.
 *
 * Regra contábil aplicada:
 *   1. Receita Bruta          = Σ valor_bruto (lançamentos de receita)
 *   2. Deduções (Taxas MDR)   = Σ taxa_mdr    (lançamentos de receita)
 *   3. Receita Líquida        = Receita Bruta - Deduções
 *   4. Despesas Operacionais  = Σ valor_bruto (lançamentos de despesa)
 *   5. Lucro Líquido          = Receita Líquida - Despesas Operacionais
 *
 * Formato esperado de cada lançamento (ajuste os nomes de campo se o seu
 * schema no lowdb usar outra convenção):
 * {
 *   tipo: 'receita' | 'despesa',
 *   data: '2026-06-29',      // string YYYY-MM-DD (ou objeto Date)
 *   valor_bruto: 2000.00,
 *   taxa_mdr: 38.00,         // normalmente só preenchido em receitas
 *   valor_liq: 1962.00       // não é usado no cálculo abaixo, é só o registro salvo
 * }
 */

// Soma um campo numérico de uma lista, blindando contra string/undefined/null
// (ex: "38.00" salvo como texto, ou campo ausente em lançamentos antigos)
function somarCampo(lista, campo) {
  return lista.reduce((soma, item) => soma + Number(item[campo] || 0), 0);
}

// Filtra os lançamentos por ano e/ou mês (ambos opcionais)
function filtrarPeriodo(transactions, { ano, mes } = {}) {
  return transactions.filter((t) => {
    const d = new Date(t.data);
    const anoOk = ano ? d.getFullYear() === Number(ano) : true;
    const mesOk = mes ? d.getMonth() + 1 === Number(mes) : true;
    return anoOk && mesOk;
  });
}

/**
 * Calcula os totais do DRE para um período (ano e/ou mês).
 * @param {Array} transactions - todos os lançamentos (db.data.transactions)
 * @param {{ano?: number|string, mes?: number|string}} periodo
 * @returns {object} totais já arredondados em 2 casas decimais
 */
function calcularTotais(transactions, periodo = {}) {
  const filtrados = filtrarPeriodo(transactions, periodo);

  const receitas = filtrados.filter((t) => t.tipo === 'receita');
  const despesas = filtrados.filter((t) => t.tipo === 'despesa');

  const receitaBruta = somarCampo(receitas, 'valor_bruto');
  const deducoes = somarCampo(receitas, 'taxa_mdr');
  const receitaLiquida = receitaBruta - deducoes;
  const despesasOperacionais = somarCampo(despesas, 'valor_bruto');
  const lucroLiquido = receitaLiquida - despesasOperacionais;

  const round2 = (n) => Number(n.toFixed(2));

  return {
    receitaBruta: round2(receitaBruta),
    deducoes: round2(deducoes),
    receitaLiquida: round2(receitaLiquida),
    despesasOperacionais: round2(despesasOperacionais),
    lucroLiquido: round2(lucroLiquido),
    margemLiquida:
      receitaBruta > 0 ? round2((lucroLiquido / receitaBruta) * 100) : 0,
  };
}

/**
 * Monta o DRE Estruturado de um ano inteiro, mês a mês, mais o total anual.
 * @param {Array} transactions
 * @param {number|string} ano
 */
function calcularDREAnual(transactions, ano) {
  const meses = Array.from({ length: 12 }, (_, i) => i + 1).map((mes) => ({
    mes,
    ...calcularTotais(transactions, { ano, mes }),
  }));

  const totalAno = calcularTotais(transactions, { ano });

  return { meses, totalAno };
}

module.exports = { calcularTotais, calcularDREAnual };
