# CBF Dashboard · Sistema de Atualização Automática

## Visão Geral

**Fluxo completo:**
```
Upload xlsx → Supabase Storage → Edge Function → Claude API → Banco de Dados → Vercel rebuild → Dashboard atualizado
```

## Desenvolvimento Local

Para rodar localmente no VS Code:

```bash
npm install
npm run dev
```

Abra uma destas URLs no navegador:

```text
http://localhost:3000
http://localhost:3000/dashboard
http://localhost:3000/dashboard.html
```

Não use `http://localhost:5501/public/dashboard.html` para este projeto. O dashboard é servido pelo Next.js, não por um servidor estático separado.

Observação prática: manter o projeto fora do OneDrive ajuda a evitar conflitos de sincronização e file watching, mas não era a causa direta do erro `ERR_CONNECTION_REFUSED`.

---

## 1. Configurar Supabase

### 1a. Criar projeto em supabase.com

### 1b. Criar o banco
No **SQL Editor** do Supabase, cole e execute o conteúdo de:
```
supabase/schema.sql
```

### 1c. Criar o bucket de storage
- Vá em **Storage → New Bucket**
- Nome: `uploads-cbf`
- Public: **desligado**
- Allowed MIME types:
  ```
  application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
  application/vnd.openxmlformats-officedocument.wordprocessingml.document
  ```

### 1d. Deploy da Edge Function
Instale o Supabase CLI e execute:
```bash
npx supabase login
npx supabase link --project-ref SEU_PROJECT_REF
npx supabase functions deploy process-upload
```

### 1e. Setar variáveis na Edge Function
No painel Supabase → **Edge Functions → process-upload → Secrets**:
```
ANTHROPIC_API_KEY = sua_chave_anthropic
VERCEL_DEPLOY_HOOK = (pegar no passo 3)
```

---

## 2. Configurar Vercel

### 2a. Push do projeto para GitHub
```bash
git init
git add .
git commit -m "CBF Dashboard inicial"
git remote add origin https://github.com/SEU_USUARIO/cbf-dashboard.git
git push -u origin main
```

### 2b. Importar no Vercel
- Acesse vercel.com → **New Project** → importar o repositório

### 2c. Configurar variáveis de ambiente no Vercel
```
NEXT_PUBLIC_SUPABASE_URL       = https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY  = eyJxxx...
SUPABASE_SERVICE_ROLE_KEY      = eyJxxx...
ADMIN_PASSWORD                 = sua_senha_forte_aqui
ANTHROPIC_API_KEY              = sk-ant-xxx...
```

### 2d. Criar Deploy Hook
- Vercel → **Settings → Git → Deploy Hooks**
- Nome: `Atualização CBF`
- Branch: `main`
- Copiar a URL gerada → colar em **VERCEL_DEPLOY_HOOK** no Supabase (passo 1e)

---

## 3. Integrar o Dashboard HTML Existente

O arquivo `cbf_dashboard_2025_v07.html` precisa ser adaptado para consumir os dados dinâmicos.

### Opção A — Simples (recomendada para início)
Adicione este script **antes** do `initCharts()` no HTML do dashboard:

```javascript
// Sobrescrever dados com os do Supabase (injetados pelo servidor)
function aplicarDadosDinamicos() {
  const D = window.__CBF_DADOS__;
  if (!D) return; // fallback para dados hardcoded

  // Os dados já estão disponíveis via window.__CBF_DADOS__
  // O initCharts() já usa as variáveis — apenas atualize-as aqui
  console.log('Dados dinâmicos carregados para período:', D.periodo);
}
aplicarDadosDinamicos();
```

### Opção B — Completa (próxima iteração)
Substituir todos os valores hardcoded do HTML por referências a `window.__CBF_DADOS__`.
Isso será feito incrementalmente conforme o sistema estabilizar.

---

## 4. Uso Mensal

### Para atualizar o dashboard mensalmente:

1. Acesse: `https://seu-dominio.vercel.app/admin`
2. Insira a senha de administrador
3. Selecione o período (ex: `2026-01`)
4. Faça upload do xlsx de DFS
5. Aguarde o processamento (~1-3 minutos)
6. O dashboard é atualizado automaticamente

### O que acontece nos bastidores:
```
[Você]          → Upload xlsx
[Supabase]      → Armazena o arquivo
[Edge Function] → Lê o xlsx
[Claude API]    → Extrai todos os dados financeiros
[Supabase DB]   → Salva o JSON estruturado
[Vercel]        → Rebuild automático do dashboard
[Dashboard]     → Exibe os dados atualizados
```

---

## 5. Estrutura do Projeto

```
cbf-dashboard/
├── src/
│   └── app/
│       ├── page.tsx              ← Dashboard principal (SSR)
│       ├── layout.tsx
│       ├── dashboard-client.tsx  ← Componente com dados dinâmicos
│       ├── admin/
│       │   └── page.tsx          ← Interface de upload
│       └── api/
│           ├── auth/route.ts     ← Autenticação
│           ├── upload/route.ts   ← Recebe e armazena arquivo
│           ├── upload-status/    ← Polling de status
│           └── uploads/          ← Histórico
├── supabase/
│   ├── schema.sql                ← Criar tabelas no Supabase
│   └── functions/
│       └── process-upload/
│           └── index.ts          ← Edge Function (IA extrai dados)
├── public/
│   └── dashboard.html            ← Copiar cbf_dashboard_2025_v07.html aqui
├── .env.example                  ← Variáveis necessárias
├── package.json
└── next.config.js
```

---

## 6. Custos Estimados

| Serviço | Plano | Custo |
|---------|-------|-------|
| Vercel | Hobby (free) | $0/mês |
| Supabase | Free tier | $0/mês |
| Claude API | Por uso | ~$0.50–2.00/upload |
| **Total** | | **~$1–2/mês** |

---

## 7. Variáveis de Ambiente (resumo)

```bash
# .env.local (desenvolvimento)
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
ADMIN_PASSWORD=senha_forte_aqui
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Suporte

Em caso de dúvidas sobre o sistema, o dashboard ou os dados:
- Verificar logs: Supabase → **Edge Functions → Logs**
- Verificar deploy: Vercel → **Deployments**
- Verificar dados: Supabase → **Table Editor → dados_financeiros**
