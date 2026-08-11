# Controle de Contas → Especificação completa para porte em Laravel

> Este documento existe pra UMA finalidade só: dar pra uma sessão de Claude
> (ou outra IA) num projeto **novo, em Laravel**, tudo que ela precisa saber
> pra reconstruir este app do zero, sem precisar abrir o repositório
> original. Descreve o QUÊ e o PORQUÊ (comportamento, regras de negócio,
> modelo de dados, UX) — não o COMO (a implementação em Node puro é uma
> decisão técnica específica daquele projeto, que não precisa nem deve ser
> replicada em Laravel). Onde a implementação original importa por afetar
> comportamento observável (ex: como um valor é validado, como uma sessão
> expira), isso está descrito.
>
> Se você é a IA lendo isso num projeto Laravel novo: leia o documento
> inteiro antes de propor arquitetura. As seções finais ("O que NÃO
> copiar" e "Pontos de atenção pro porte") existem justamente pra você não
> replicar decisões que só faziam sentido no contexto do projeto Node.

## 1. O que o app faz (visão de produto)

App pessoal de controle financeiro mensal, multi-usuário (cada usuário só
vê os próprios dados). Tem **duas telas de lançamento, de propósito
separadas**:

- **Contas** — contas com vencimento: aluguel, cartão, assinaturas. Têm
  status pago/pendente (`ok`) e podem se repetir todo mês (`fixo`).
- **Gastos** — compras avulsas do dia a dia: mercado, besteira, cinema.
  Sem vencimento, sem status, sem repetição. Categorizadas pra saber
  quanto está saindo em cada tipo de gasto.

As duas telas compartilham o mesmo conceito de "mês" (ano/mês por
usuário) — criar ou excluir um mês afeta as duas ao mesmo tempo. Fora
isso, as listas de categoria e os itens são completamente independentes
entre Contas e Gastos.

Há também autenticação (cadastro, login, logout, exclusão de conta) e um
perfil de usuário simples (nome, sobrenome, nascimento, país, estado, e um
campo bônus de texto livre "gasto bobo").

## 2. Modelo de dados

Cadeia de posse — cada tabela principal tem `usuario_id` **direto** (sem
precisar de JOIN pra saber o dono), exceto onde indicado:

```
usuarios (1) ---- (1) pessoas
usuarios (1) ---- (N) sessoes
usuarios (1) ---- (N) agrupamentos
usuarios (1) ---- (N) categorias_gasto
usuarios (1) ---- (N) meses
usuarios (1) ---- (N) lancamentos   [tem usuario_id direto, além de mes_id e agrupamento_id]
usuarios (1) ---- (N) gastos        [tem usuario_id direto, além de mes_id e categoria_gasto_id]
```

### `usuarios`
| Campo | Tipo/regra |
|---|---|
| `usuario` | texto, único **case-insensitive**, mínimo 3 caracteres, só `[a-zA-Z0-9_.]` |
| `email` | texto, único **case-insensitive**, formato de e-mail válido |
| `senha_hash` / `senha_salt` | hash de senha com salt; nunca texto puro (ver seção 5) |
| `criado_em` | timestamp |

### `pessoas` (perfil, 1-pra-1 com usuário, tabela separada de propósito)
`usuario_id` (único), `nome`, `sobrenome`, `data_nascimento`, `pais`,
`estado`, `gasto_bobo` (texto livre opcional, é uma pergunta de
personalidade/curiosidade no wizard de cadastro, não tem uso funcional).
Todos os campos de perfil (exceto `usuario_id`) são opcionais no banco —
o wizard os pede um de cada vez mas tecnicamente nenhum é obrigatório pro
registro em si (a obrigatoriedade de preencher é só da UX do wizard).

### `sessoes` (uma linha por login feito)
`token` (chave primária — é o valor do cookie), `usuario_id`, `criado_em`,
`expira_em`. Sessão dura **30 dias fixos a partir da criação** (sem
renovação por atividade — se o usuário voltar no dia 29, a sessão morre
no dia 30 mesmo assim). Login de novo cria uma linha nova; nada limita
quantas sessões simultâneas um usuário pode ter.

### `agrupamentos` (categorias de Contas — "Contas Fixas", "Bancos", "Cartão X"...)
`usuario_id`, `nome` (único **por usuário**, case-insensitive), `ordem`
(inteiro, define a ordem de exibição, reordenável via mover para
cima/baixo).

### `categorias_gasto` (categorias de Gastos — "Mercado", "Cinema", "Besteira"...)
Mesmíssimo formato de `agrupamentos`, mas é **uma lista separada** — Gastos
não reaproveita os agrupamentos de Contas.

### `meses` (compartilhado entre Contas e Gastos)
`usuario_id`, `ano`, `mes` (1–12), `criado_em`. Único por
`(usuario_id, ano, mes)`. **Regra deliberada do produto**: só aceita anos
de uma faixa restrita (no projeto original, `[2026, 2027]`) — "ninguém faz
conta pro passado". Essa faixa é uma constante configurável no código, não
input livre do usuário.

### `lancamentos` (item de Contas)
| Campo | Tipo/regra |
|---|---|
| `usuario_id`, `mes_id`, `agrupamento_id` | referências |
| `descricao` | texto, obrigatório |
| `valor` | numérico, decimal (moeda) |
| `detalhe` | texto livre opcional |
| `data_limite` | data opcional (`YYYY-MM-DD`), é o vencimento |
| `ok` | booleano — pago/pendente |
| `fixo` | booleano — ver seção 3 (comportamento sutil, ler com atenção) |
| `ordem` | inteiro, ordem de exibição dentro do agrupamento |

### `gastos` (item de Gastos)
| Campo | Tipo/regra |
|---|---|
| `usuario_id`, `mes_id`, `categoria_gasto_id` | referências |
| `nome` | texto curto, **obrigatório** (ex: "Compras do dia a dia") |
| `descricao` | texto livre **opcional**, detalha o nome (ex: "Frutas, carne e produtos de limpeza") |
| `valor` | numérico, decimal |
| `data_compra` | data opcional |
| `ordem` | inteiro |

Sem `ok`/`fixo` — gasto já é uma compra consumada, não tem "pendente" nem
repetição.

## 3. Regra de negócio mais sutil do sistema: o comportamento "fixo"

**`fixo` não é um cadastro de "contas fixas" separado.** É uma flag por
linha de `lancamentos`, específica daquele mês. Quando um mês novo é
criado:

1. O sistema acha o mês existente mais recente **cronologicamente
   anterior** ao que está sendo criado (não precisa ser o mês
   imediatamente anterior — se só existir Maio e o usuário pular direto
   pra criar Agosto, a referência é Maio).
2. Copia pro mês novo só os lançamentos daquele mês de referência que
   estavam com `fixo = true` — com `descricao`, `valor`, `detalhe` e
   `agrupamento` idênticos.
3. Se a conta copiada tinha `data_limite`, o **dia** é preservado mas
   ajustado pro mês novo (ex: vencimento dia 31 de janeiro vira dia 28 ou
   29 em fevereiro — usar o último dia válido do mês de destino quando o
   dia original não existir nele).
4. Os itens copiados entram sempre com `ok = false` — ninguém nasce pago.

Desmarcar `fixo` num lançamento não afeta o histórico daquele mês — só
impede que ele seja copiado da próxima vez que um mês novo for criado.

## 4. API / casos de uso (contrato funcional, não a sintaxe HTTP em si)

Toda operação de leitura/escrita de dado exige usuário autenticado e **é
sempre implicitamente filtrada por esse usuário** — um usuário nunca deve
conseguir ler ou mutar dado de outro. Ao buscar um registro por id que não
existe (ou existe mas pertence a outro usuário), a resposta correta é
**"não encontrado"**, nunca "acesso negado" — não dar pista pra quem
estiver adivinhando IDs sobre se aquele registro existe ou não (ver seção
5, é uma decisão de segurança deliberada, não regredir nisso ao portar).

### Autenticação
- **Verificar disponibilidade** de usuário/e-mail antes de finalizar
  cadastro (usado no wizard, ver seção 6).
- **Registrar**: cria usuário + perfil (`pessoas`) numa operação só, já
  abre sessão.
- **Login**: aceita usuário OU e-mail + senha.
- **Logout**: encerra a sessão atual.
- **Eu**: devolve quem está logado + perfil, ou "não logado".
- **Excluir conta**: apaga usuário + perfil + sessões + agrupamentos +
  categorias + todos os meses + todos os lançamentos + todos os gastos,
  numa transação atômica (tudo ou nada).

### Agrupamentos / Categorias de Gasto (mesmo padrão pros dois)
- Listar (com flag "em uso" — se tem algum item usando essa categoria).
- Criar (nome único por usuário).
- Renomear.
- Reordenar (mover um passo pra cima/baixo na lista).
- Excluir — **só permitido se não estiver em uso** (nenhum lançamento/gasto
  referencia). Se estiver em uso, recusar e sugerir renomear em vez de
  excluir.

### Meses
- Listar os meses do usuário (com totais resumidos de Contas).
- Sugerir o próximo ano/mês a criar (o mês seguinte ao mais recente que já
  existe; se não existir nenhum, sugere o mês/ano atual do calendário).
- Buscar um mês específico por ano/mês — devolve "não existe" se ainda não
  foi criado (usado tanto por Contas quanto por Gastos, cada um buscando
  os próprios itens desse mesmo mês).
- Criar mês novo — dispara a cópia de fixos descrita na seção 3. O mês
  criado fica disponível pros dois lados (Contas e Gastos) imediatamente.
- Excluir mês — apaga o mês **e todos os lançamentos e gastos daquele
  mês**, nos dois lados, numa transação. É destrutivo e a UI deve avisar
  isso explicitamente antes de confirmar (o texto de confirmação original
  diz literalmente "isso apaga TODOS os lançamentos de Contas E todos os
  Gastos deste mês").

### Lançamentos (Contas)
- Criar (aceita escolher um agrupamento existente OU criar um novo pelo
  nome na mesma operação — ver "resolver categoria/agrupamento por id ou
  por nome" abaixo).
- Editar campos parciais (descrição, valor, detalhe, data limite, status
  pago/pendente).
- Alternar a flag `fixo` isoladamente (ação própria, não faz parte do
  PATCH genérico).
- Excluir (só remove daquele mês, não afeta histórico de outros meses).

Toda mutação devolve **o mês inteiro recalculado** (itens + totais), não
só o item alterado — a UI sempre re-renderiza a partir da resposta, nunca
faz update otimista local sem confirmação do servidor.

### Gastos
Mesmíssimo padrão de Lançamentos (criar/editar parcial/excluir, devolve o
mês inteiro), mas os campos são `nome` (obrigatório) + `descricao`
(opcional) + `valor` + `data_compra`, sem `ok`/`fixo`.

### Padrão "resolver categoria por id ou por nome"
Tanto criar um lançamento quanto um gasto aceita **ou** um id de
agrupamento/categoria existente, **ou** o nome de um novo — se vier nome e
já existir uma categoria com esse nome (case-insensitive) pro mesmo
usuário, reaproveita ela em vez de duplicar; se não existir, cria na hora.
Isso existe pra permitir "criar categoria nova direto no formulário de
adicionar item", sem precisar de uma tela separada primeiro.

## 5. Segurança — decisões que não podem regredir no porte

- **IDOR**: qualquer busca por id de um registro pertencente a um usuário
  (lançamento, gasto, mês, agrupamento, categoria) deve filtrar pelo
  usuário autenticado. Não achar deve sempre resultar em "não encontrado"
  — nunca em "proibido", mesmo quando o registro existe mas é de outro
  usuário (evita confirmar pra um atacante que um ID específico existe).
- **SQL Injection**: sempre usar queries parametrizadas — nunca concatenar
  input de usuário numa string de SQL. (Em Laravel: Eloquent/query builder
  já resolve isso por padrão; só tomar cuidado se algum dia usar
  `DB::raw` com valor de usuário.)
- **Senha**: nunca guardar em texto puro. Hash lento com salt aleatório
  por usuário, comparação em tempo constante. (Em Laravel: usar o `Hash`
  facade nativo — resolve isso sem reinventar nada; não precisa portar o
  scrypt manual do projeto original, aquilo só existia porque o Node puro
  não tinha um `Hash::make` embutido.)
- **Sessão**: cookie `HttpOnly` (JS do navegador não lê) — se um dia isso
  virar HTTPS de verdade, o cookie também precisa da flag `Secure`. (Em
  Laravel: o sistema de sessão nativo, ou Sanctum, já cobre isso.)
- **Validação de ano/mês**: mês criado só dentro de uma faixa de anos
  permitida (regra de produto, não só técnica — ver seção 2).

## 6. Front-end — telas e comportamento de UX a preservar

O app tem 4 telas. As duas telas internas (Contas, Gastos) e as duas
públicas (login, cadastro) têm estilos visuais consistentes entre si
(tema escuro, mesma paleta de cores) mas propositalmente headers/estilo
próprio nas telas de auth (mais focadas, sem o header cheio do app
principal).

### Contas (`index.html` equivalente)
- Seletor de **Ano** e **Mês** no topo — o mês selecionado é persistido
  (ex: localStorage) e **compartilhado com a tela de Gastos** (trocar de
  tela não reseta a seleção).
- 4 cards de resumo: Total do mês, Pago, Pendente, e um card de "valor
  selecionado" (soma dinâmica dos itens marcados via checkbox).
- Itens agrupados por agrupamento, com um checkbox no cabeçalho de cada
  grupo que seleciona/desmarca todos os itens daquele grupo de uma vez
  (estado indeterminado quando só parte está marcada). Um checkbox
  "selecionar tudo" no topo com a mesma lógica tri-state.
- Edição **inline por linha**: clicar no ícone de lápis transforma aquela
  linha em campos editáveis (não é contenteditable direto na célula);
  Enter salva, Esc cancela; só uma linha em edição por vez.
- Botão de alternar status pago/pendente por item (toggle direto, sem
  precisar entrar em modo de edição).
- Botão de alternar `fixo` por item (toggle direto, com feedback via
  toast explicando o que a flag significa).
- Formulário de "adicionar conta": categoria (select existente ou opção
  "criar nova" que revela um campo de texto), descrição, valor, detalhe
  opcional, data limite opcional, checkbox "repete todo mês".
- Painel de "gerenciar agrupamentos": lista com nome editável inline
  (editar ao perder foco), botões de mover pra cima/baixo, excluir (com
  aviso se estiver em uso), e criar novo.
- Botão de excluir mês (com confirmação explícita e destrutiva — avisa
  que afeta Contas E Gastos).
- Botão de "ocultar valores" — mascara visualmente os valores em tela
  (não é criptografia, é preferência de privacidade visual, tipo "alguém
  olhando por cima do ombro"), preferência persistida separadamente da de
  Gastos.
- **Responsivo**: abaixo de ~700px de largura, a tabela vira uma lista de
  cards empilhados (mesmos dados, mesmas ações, layout diferente) —
  detectado por media query de largura de tela (nunca por
  user-agent), re-renderiza ao vivo se a janela cruzar o breakpoint.

### Gastos
Espelha Contas quase 1:1 na estrutura de UX (mesmo seletor de período
compartilhado, mesmo padrão de seleção múltipla com subtotal, mesma edição
inline, mesmo painel de gerenciar categorias, mesmo toggle de ocultar
valores com chave própria, mesmo comportamento responsivo), mas mais
simples: sem status pago/pendente, sem flag fixo, dois campos por item
(nome obrigatório + descrição opcional) em vez do par
descrição/detalhe de Contas, e "categoria" em vez de "agrupamento".

### Login
Tela única e simples: campo usuário-ou-e-mail + senha. Foco automático no
primeiro campo, Enter em qualquer campo tenta o login, estado de
carregamento no botão (spinner + texto "Entrando...").

### Cadastro (wizard)
**Uma pergunta por vez**, mobile-first, com barra de progresso no topo:

1. Tela 0 (credenciais, todos os campos juntos): usuário, e-mail, senha,
   confirmação de senha. Ao avançar, checa disponibilidade de
   usuário/e-mail no servidor antes de ir pro próximo passo (evita o
   usuário preencher tudo e só descobrir no fim que o nome já existe).
2. Tela 1: nome.
3. Tela 2: sobrenome.
4. Tela 3: data de nascimento (valida que não é no futuro e não é
   absurdamente antiga).
5. Tela 4: país.
6. Tela 5: estado — select com as 27 UFs do Brasil + opção "Outro / fora
   do Brasil" que revela um campo de texto livre.
7. Tela 6 (bônus, opcional): pergunta de personalidade/curiosidade
   ("qual é aquele gasto que você sabe que é bobo, mas não resiste?") —
   tem botão "Pular" além de "Concluir".

Cada tela tem botão "← Voltar" (exceto a primeira) que preserva o que já
foi digitado. Transição suave (fade + leve deslocamento vertical) entre
passos. Ao concluir, chama o registro, mostra uma tela de sucesso
(animação de check) e redireciona pro app.

### Utilitários de UX compartilhados (comportamento a preservar, não a
implementação)
- **Máscara de valor monetário**: campo de valor se comporta como
  "digitar centavos" (tipo app de banco) — cada dígito novo entra pela
  direita e o campo já mostra formatado em tempo real (ex: digitar
  "150000" mostra "R$ 1.500,00" progressivamente). Aceita também colar um
  valor já formatado em BR (`150,50`) ou com ponto decimal (`150.50`) na
  hora de interpretar o texto de volta pra número.
- **Toast** de feedback (sucesso/erro) no canto da tela, com timeout
  automático.
- **Confirmação nativa do navegador** (`confirm()`) antes de qualquer
  ação destrutiva (excluir item, excluir categoria em uso teria sido
  bloqueado antes, excluir mês).
- **Detecção de mobile por largura de tela**, nunca por user-agent.

## 7. O que NÃO copiar literalmente (específico da stack Node original)

Essas escolhas existiam só porque o projeto original tinha uma regra
própria de **zero dependência externa** (rodar só com módulos nativos do
Node) — essa restrição não existe em Laravel, que já tem um ecossistema
de framework completo. Não portar:

- **`node:sqlite` como banco** — em Laravel use o banco que fizer mais
  sentido pro novo projeto (MySQL/Postgres/SQLite via Eloquent), com
  migrations de verdade (ver seção 8, isso é o oposto do projeto
  original).
- **Roteamento manual num `if/else` gigante** — use as rotas e
  controllers do Laravel normalmente.
- **Scrypt manual com `crypto` do Node** — use `Hash::make` /
  `Hash::check` do Laravel.
- **Cookie de sessão feito à mão (parse manual de `Set-Cookie`)** — use o
  sistema de sessão/autenticação nativo do Laravel (session guard,
  Sanctum se for SPA/API).
- **Checagem manual de path traversal no serve de arquivo estático** —
  não se aplica; Laravel serve views/assets do jeito dele.
- **CSS/JS embutido inline em cada HTML sem framework de front** — decisão
  livre do novo projeto: pode usar Blade puro, Livewire, Inertia+Vue/React,
  etc. O documento não prescreve isso — é uma decisão em aberto pro porte.

## 8. Pontos de atenção específicos pro porte (decisões que precisam de
escolha deliberada, não são "só traduzir")

- **Unicidade case-insensitive de `usuario`/`email`/nome de
  agrupamento/categoria**: o original usa `COLLATE NOCASE` do SQLite.
  Em Laravel/MySQL isso costuma já vir de graça (collation
  case-insensitive por padrão), mas em Postgres precisa de índice
  funcional (`LOWER(coluna)`) ou extensão `citext` — decidir conforme o
  banco escolhido.
- **Regra de negócio "fixo" (seção 3)** é a parte mais fácil de
  simplificar sem querer ao portar — é tentador modelar como "template de
  conta recorrente" separado, mas o comportamento real é só "copiar o que
  estava marcado no mês de referência anterior, uma vez, no momento de
  criar o mês novo". Não é um agendamento nem um cron.
- **Mês compartilhado entre Contas e Gastos**: se o novo projeto crescer
  com mais tipos de lançamento (investimentos, recebimentos), o padrão a
  seguir é o mesmo do original: tela própria + categoria própria + tabela
  de item própria, todas isoladas por usuário, compartilhando o mesmo
  conceito de "mês" quando fizer sentido.
- **Faixa de anos permitida (`[2026, 2027]` no original)**: hoje é uma
  constante fixa no código, não um input livre — decidir se no novo
  projeto isso vira algo configurável ou continua fixo.
- **Ajuste de dia ao copiar conta fixa pro mês novo** (dia 31 → 28/29):
  lógica pequena mas fácil de esquecer — sem ela, uma conta fixa com
  vencimento dia 31 quebraria ao copiar pra um mês de 30 ou menos dias.
- **Resposta de mutação sempre devolve o "mês inteiro" recalculado**: o
  front-end original nunca calcula totais localmente nem faz update
  otimista sem confirmação — sempre re-renderiza a partir do que o
  servidor devolveu. Vale manter esse contrato (ou um equivalente,
  como recarregar via Livewire/Inertia) pra evitar bugs de total
  dessincronizado entre cliente e servidor.
- **Estado atual dos dados reais**: o projeto original tem hoje 2 usuários
  reais (`Yuri` e `Alyssu`) com dados de verdade num arquivo SQLite. Isso
  é só contexto do projeto original — o projeto Laravel novo começa do
  zero, sem precisar migrar esses dados (a menos que o Yuri peça
  explicitamente uma migração de dados, o que é uma tarefa à parte, fora
  do escopo deste documento).
