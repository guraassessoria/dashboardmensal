-- ════════════════════════════════════════════════════════
-- CBF Dashboard · Migração Incremental
-- Execute no SQL Editor do Supabase Dashboard
-- https://supabase.com/dashboard/project/uqthbzqpsgfflljxepen/sql
-- ════════════════════════════════════════════════════════

-- 1. Coluna tipo_documento na tabela uploads
ALTER TABLE uploads 
  ADD COLUMN IF NOT EXISTS tipo_documento TEXT DEFAULT 'dfs';

-- 2. Tabela de usuários do dashboard
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

-- 3. RLS para dashboard_users
ALTER TABLE dashboard_users ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'dashboard_users' AND policyname = 'Leitura pública dashboard_users') THEN
    CREATE POLICY "Leitura pública dashboard_users" ON dashboard_users FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'dashboard_users' AND policyname = 'Apenas service_role insere dashboard_users') THEN
    CREATE POLICY "Apenas service_role insere dashboard_users" ON dashboard_users FOR INSERT WITH CHECK (auth.role() = 'service_role');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'dashboard_users' AND policyname = 'Apenas service_role atualiza dashboard_users') THEN
    CREATE POLICY "Apenas service_role atualiza dashboard_users" ON dashboard_users FOR UPDATE USING (auth.role() = 'service_role');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'dashboard_users' AND policyname = 'Apenas service_role deleta dashboard_users') THEN
    CREATE POLICY "Apenas service_role deleta dashboard_users" ON dashboard_users FOR DELETE USING (auth.role() = 'service_role');
  END IF;
END $$;

-- 4. Tabela de insights (se não existir)
CREATE TABLE IF NOT EXISTS insights_gerados (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  periodo     TEXT NOT NULL UNIQUE,
  upload_id   UUID REFERENCES uploads(id),
  conteudo    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insights_periodo ON insights_gerados(periodo DESC);

ALTER TABLE insights_gerados ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'insights_gerados' AND policyname = 'Leitura pública insights') THEN
    CREATE POLICY "Leitura pública insights" ON insights_gerados FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'insights_gerados' AND policyname = 'Apenas service_role insere insights') THEN
    CREATE POLICY "Apenas service_role insere insights" ON insights_gerados FOR INSERT WITH CHECK (auth.role() = 'service_role');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'insights_gerados' AND policyname = 'Apenas service_role atualiza insights') THEN
    CREATE POLICY "Apenas service_role atualiza insights" ON insights_gerados FOR UPDATE USING (auth.role() = 'service_role');
  END IF;
END $$;

-- 5. Verificação final
SELECT 'uploads' as tabela, count(*) as registros FROM uploads
UNION ALL
SELECT 'dados_financeiros', count(*) FROM dados_financeiros
UNION ALL
SELECT 'configuracao', count(*) FROM configuracao
UNION ALL
SELECT 'insights_gerados', count(*) FROM insights_gerados
UNION ALL
SELECT 'dashboard_users', count(*) FROM dashboard_users;
