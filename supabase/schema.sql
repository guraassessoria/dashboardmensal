-- ════════════════════════════════════════════════════
-- CBF Dashboard · Schema Supabase
-- Execute no SQL Editor do Supabase
-- ════════════════════════════════════════════════════

-- Tabela de uploads (histórico de versões)
CREATE TABLE IF NOT EXISTS uploads (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  filename    TEXT NOT NULL,
  file_type   TEXT NOT NULL CHECK (file_type IN ('xlsx', 'docx')),
  storage_path TEXT NOT NULL,
  periodo     TEXT,          -- ex: "2025-12", "2026-01"
  status      TEXT DEFAULT 'pending' CHECK (status IN ('pending','processing','done','error')),
  error_msg   TEXT,
  tipo_documento TEXT DEFAULT 'dfs',
  uploaded_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Tabela principal de dados financeiros (uma linha por período)
CREATE TABLE IF NOT EXISTS dados_financeiros (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  periodo       TEXT NOT NULL UNIQUE,  -- ex: "2025-12"
  upload_id     UUID REFERENCES uploads(id),
  source_file   TEXT,                  -- nome original do xlsx
  
  -- DRE (valores em R$ milhares)
  receita_bruta         NUMERIC,
  receita_liquida       NUMERIC,
  custos_futebol        NUMERIC,
  superavit_bruto       NUMERIC,
  despesas_operacionais NUMERIC,
  resultado_financeiro  NUMERIC,
  resultado_exercicio   NUMERIC,
  
  -- Detalhamento Receitas
  rec_patrocinio        NUMERIC,
  rec_transmissao       NUMERIC,
  rec_bilheteria        NUMERIC,
  rec_registros         NUMERIC,
  rec_desenvolvimento   NUMERIC,
  rec_academy           NUMERIC,
  rec_financeiras       NUMERIC,
  
  -- Detalhamento Custos Futebol
  custo_selecao_principal  NUMERIC,
  custo_selecao_base       NUMERIC,
  custo_selecao_femininas  NUMERIC,
  custo_fomento            NUMERIC,
  
  -- Detalhamento Despesas Operacionais
  desp_pessoal          NUMERIC,
  desp_administrativas  NUMERIC,
  desp_impostos_taxas   NUMERIC,
  
  -- Resultado Financeiro detalhado
  res_fin_receitas      NUMERIC,
  res_fin_despesas      NUMERIC,
  res_fin_cambial       NUMERIC,
  
  -- Balanço Patrimonial
  ativo_total           NUMERIC,
  ativo_circulante      NUMERIC,
  caixa_equivalentes    NUMERIC,
  contas_receber        NUMERIC,
  tributos_recuperar    NUMERIC,
  depositos_judiciais   NUMERIC,
  imobilizado           NUMERIC,
  
  passivo_circulante    NUMERIC,
  ir_csll_cp            NUMERIC,
  receitas_diferidas_cp NUMERIC,
  receitas_diferidas_lp NUMERIC,
  prov_contingencias    NUMERIC,
  
  patrimonio_liquido    NUMERIC,
  patrimonio_social     NUMERIC,
  
  -- DFC
  fluxo_operacional     NUMERIC,
  fluxo_investimento    NUMERIC,
  variacao_caixa        NUMERIC,
  
  -- Indicadores calculados (gerados automaticamente)
  liquidez_corrente     NUMERIC GENERATED ALWAYS AS (
    CASE WHEN passivo_circulante > 0 
    THEN ativo_circulante / passivo_circulante 
    ELSE NULL END
  ) STORED,
  liquidez_imediata     NUMERIC GENERATED ALWAYS AS (
    CASE WHEN passivo_circulante > 0 
    THEN caixa_equivalentes / passivo_circulante 
    ELSE NULL END
  ) STORED,
  
  -- JSON completo (fallback para dados extras)
  dados_raw             JSONB,
  
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- Índice para buscar período mais recente
CREATE INDEX IF NOT EXISTS idx_dados_periodo ON dados_financeiros(periodo DESC);

-- Tabela de configuração/metadados do dashboard
CREATE TABLE IF NOT EXISTS configuracao (
  chave  TEXT PRIMARY KEY,
  valor  TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Valores iniciais
INSERT INTO configuracao (chave, valor) VALUES
  ('periodo_atual', '2025-12'),
  ('versao_dashboard', 'v07'),
  ('titulo', 'CBF — Demonstrações Financeiras')
ON CONFLICT (chave) DO NOTHING;

-- Tabela de insights gerados por IA (uma linha por período)
CREATE TABLE IF NOT EXISTS insights_gerados (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  periodo     TEXT NOT NULL UNIQUE,
  upload_id   UUID REFERENCES uploads(id),
  conteudo    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insights_periodo ON insights_gerados(periodo DESC);

-- Tabela de usuários do dashboard
CREATE TABLE IF NOT EXISTS dashboard_users (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  nome_completo  TEXT,
  ativo          BOOLEAN DEFAULT true,
  role           TEXT NOT NULL DEFAULT 'editor',  -- admin | editor | consulta
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE dashboard_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leitura pública dashboard_users"
  ON dashboard_users FOR SELECT USING (true);

CREATE POLICY "Apenas service_role insere dashboard_users"
  ON dashboard_users FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Apenas service_role atualiza dashboard_users"
  ON dashboard_users FOR UPDATE USING (auth.role() = 'service_role');

CREATE POLICY "Apenas service_role deleta dashboard_users"
  ON dashboard_users FOR DELETE USING (auth.role() = 'service_role');

-- Storage bucket para os arquivos
-- (Execute via Supabase Dashboard > Storage > New Bucket)
-- Nome: "uploads-cbf"
-- Public: false
-- Allowed MIME: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,
--               application/vnd.openxmlformats-officedocument.wordprocessingml.document

-- RLS: apenas service_role pode inserir/ler dados financeiros
ALTER TABLE dados_financeiros ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leitura pública dados financeiros"
  ON dados_financeiros FOR SELECT USING (true);

CREATE POLICY "Apenas service_role insere dados"
  ON dados_financeiros FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Apenas service_role atualiza dados"
  ON dados_financeiros FOR UPDATE USING (auth.role() = 'service_role');

CREATE POLICY "Leitura pública uploads"
  ON uploads FOR SELECT USING (true);

CREATE POLICY "Apenas service_role insere uploads"
  ON uploads FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Apenas service_role atualiza uploads"
  ON uploads FOR UPDATE USING (auth.role() = 'service_role');

-- RLS para insights_gerados
ALTER TABLE insights_gerados ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leitura pública insights"
  ON insights_gerados FOR SELECT USING (true);

CREATE POLICY "Apenas service_role insere insights"
  ON insights_gerados FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Apenas service_role atualiza insights"
  ON insights_gerados FOR UPDATE USING (auth.role() = 'service_role');
