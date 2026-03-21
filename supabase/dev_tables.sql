-- Dev environment tables (isolated from production)

CREATE TABLE IF NOT EXISTS dev_uploads (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  filename text NOT NULL,
  file_type text NOT NULL DEFAULT 'xlsx',
  storage_path text NOT NULL,
  periodo text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error_msg text,
  uploaded_at timestamptz DEFAULT now(),
  processed_at timestamptz,
  tipo_documento text NOT NULL DEFAULT 'dfs'
);

CREATE TABLE IF NOT EXISTS dev_dados_financeiros (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  periodo text UNIQUE NOT NULL,
  upload_id uuid REFERENCES dev_uploads(id),
  source_file text,
  receita_bruta numeric, receita_liquida numeric, custos_futebol numeric,
  superavit_bruto numeric, despesas_operacionais numeric, resultado_financeiro numeric,
  resultado_exercicio numeric,
  rec_patrocinio numeric, rec_transmissao numeric, rec_bilheteria numeric,
  rec_registros numeric, rec_desenvolvimento numeric, rec_academy numeric, rec_financeiras numeric,
  custo_selecao_principal numeric, custo_selecao_base numeric,
  custo_selecao_femininas numeric, custo_fomento numeric,
  desp_pessoal numeric, desp_administrativas numeric, desp_impostos_taxas numeric,
  res_fin_receitas numeric, res_fin_despesas numeric, res_fin_cambial numeric,
  ativo_total numeric, ativo_circulante numeric, caixa_equivalentes numeric,
  contas_receber numeric, tributos_recuperar numeric, depositos_judiciais numeric,
  imobilizado numeric, passivo_circulante numeric,
  receitas_diferidas_cp numeric, receitas_diferidas_lp numeric,
  prov_contingencias numeric, patrimonio_liquido numeric, patrimonio_social numeric,
  fluxo_operacional numeric, fluxo_investimento numeric, variacao_caixa numeric,
  dados_raw jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dev_insights_gerados (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  periodo text UNIQUE NOT NULL,
  upload_id uuid,
  conteudo jsonb NOT NULL DEFAULT '{}'::jsonb,
  editado_por text,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dev_configuracao (
  chave text PRIMARY KEY,
  valor text,
  updated_at timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE dev_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_dados_financeiros ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_insights_gerados ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_configuracao ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dev_uploads_select') THEN
    CREATE POLICY dev_uploads_select ON dev_uploads FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dev_uploads_all') THEN
    CREATE POLICY dev_uploads_all ON dev_uploads FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dev_dados_select') THEN
    CREATE POLICY dev_dados_select ON dev_dados_financeiros FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dev_dados_all') THEN
    CREATE POLICY dev_dados_all ON dev_dados_financeiros FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dev_insights_select') THEN
    CREATE POLICY dev_insights_select ON dev_insights_gerados FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dev_insights_all') THEN
    CREATE POLICY dev_insights_all ON dev_insights_gerados FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dev_config_select') THEN
    CREATE POLICY dev_config_select ON dev_configuracao FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dev_config_all') THEN
    CREATE POLICY dev_config_all ON dev_configuracao FOR ALL USING (true);
  END IF;
END $$;
