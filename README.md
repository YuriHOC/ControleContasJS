# Controle de Contas

Software local de controle de contas mensais, com histórico completo salvo em banco de dados.

## Como usar

1. Precisa ter o [Node.js](https://nodejs.org) instalado (versão 22.5 ou mais nova) no computador.
2. Dê **duplo-clique em `iniciar.bat`** — o navegador abre sozinho em `http://localhost:5602`.
   - Ou, pelo terminal: `node server.js` (dentro desta pasta) e depois abra `http://localhost:5602`.
3. Para parar o programa, feche a janela preta (o terminal) que abriu.

## Levar para outro computador / pendrive

É só copiar esta pasta inteira (`ControleContas`) para o novo lugar. O banco de dados
(`data/controle.sqlite`) vai junto, com todo o histórico de meses. Não precisa instalar
nada além do Node.js.

## Como funciona

- Cada mês vira um registro no banco (histórico permanente — nada é apagado a menos que
  você use "🗑️ Excluir mês" de propósito).
- Navegue pelo histórico com os seletores **Ano** e **Mês** no topo. Se o período
  escolhido ainda não existe, a tela oferece criar ele na hora.
- **"📅 Iniciar novo mês"** cria automaticamente o próximo mês em sequência.
- **Fixo não é um cadastro fixo de verdade** — é um comportamento: toda vez que você cria
  um mês novo, o sistema olha o que está marcado como **🔁 Fixo** no mês mais recente e
  copia essas contas para o mês novo (zeradas, sem OK). Se você desmarcar uma conta como
  fixa em um mês, ela simplesmente não é copiada no próximo — mas continua no histórico
  daquele mês normalmente.
- Contas variáveis (ex: faturas de cartão) não são fixas por padrão — adicione-as
  manualmente todo mês com "+ Adicionar conta", ou clique em "＋ Fixar" para que passem a
  se repetir a partir do próximo mês.
- **"⚙️ Agrupamentos"** deixa criar, renomear, reordenar ou excluir categorias (tipo
  "Contas Fixas", "Bancos", "Cartão Wyne"...). Um agrupamento só pode ser excluído se não
  tiver nenhum lançamento no histórico (senão, renomeie em vez de excluir).
- **"🗑️ Excluir mês"** apaga o mês inteiro (com confirmação) — útil se você errou tudo e
  prefere recomeçar aquele mês do zero.
- Remover uma conta individual afeta só o mês selecionado — os outros meses no histórico
  continuam intactos.

## Estrutura

```
ControleContas/
  server.js        servidor (Node.js puro + node:sqlite, sem dependências externas)
  package.json
  iniciar.bat       atalho para iniciar no Windows
  public/
    index.html      interface
  data/
    controle.sqlite  banco de dados (criado automaticamente)
```
