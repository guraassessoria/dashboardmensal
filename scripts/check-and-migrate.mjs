/**
 * Script para verificar e executar migração no Supabase
 * Usa o service_role key para acessar o banco via REST API
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ler .env.local
const envPath = resolve(__dirname, '..', '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m) env[m[1]] = m[2];
}

const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SVC_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA_URL || !SVC_KEY) {
  console.error('Missing SUPABASE env vars in .env.local');
  process.exit(1);
}

const headers = {
  'apikey': SVC_KEY,
  'Authorization': `Bearer ${SVC_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

async function checkTable(name, selectCols = 'id') {
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/${name}?select=${selectCols}&limit=1`, { headers });
    if (r.ok) {
      const data = await r.json();
      return { exists: true, count: data.length };
    }
    const err = await r.json();
    return { exists: false, error: err.message || err.code };
  } catch (e) {
    return { exists: false, error: e.message };
  }
}

async function runSQL(sql) {
  // Use the Supabase Management API via the pg endpoint  
  // Actually, we use the PostgREST rpc or the SQL endpoint
  // Supabase exposes a SQL endpoint at /pg for service_role
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql })
  });
  return r;
}

console.log('═══════════════════════════════════════');
console.log('  CBF Dashboard - Supabase Check');
console.log('═══════════════════════════════════════');
console.log(`URL: ${SUPA_URL}\n`);

// Check all tables
const tables = [
  { name: 'uploads', cols: 'id,tipo_documento' },
  { name: 'dados_financeiros', cols: 'periodo' },
  { name: 'configuracao', cols: 'chave' },
  { name: 'dashboard_users', cols: 'id' },
  { name: 'insights_gerados', cols: 'id' },
];

let missingTables = [];
let missingColumns = [];

for (const t of tables) {
  const result = await checkTable(t.name, t.cols);
  if (result.exists) {
    console.log(`  ✅ ${t.name} - OK`);
  } else {
    console.log(`  ❌ ${t.name} - ${result.error}`);
    if (result.error?.includes('does not exist') || result.error?.includes('404') || result.error?.includes('relation')) {
      missingTables.push(t.name);
    } else if (result.error?.includes('column')) {
      missingColumns.push({ table: t.name, detail: result.error });
    } else {
      missingTables.push(t.name);
    }
  }
}

// Check uploads.tipo_documento specifically
const uploadsCheck = await checkTable('uploads', 'tipo_documento');
if (!uploadsCheck.exists && uploadsCheck.error?.includes('column')) {
  console.log(`  ⚠️  uploads.tipo_documento column missing`);
  missingColumns.push({ table: 'uploads', column: 'tipo_documento' });
}

console.log('\n═══════════════════════════════════════');

if (missingTables.length === 0 && missingColumns.length === 0) {
  console.log('  ✅ Todas as tabelas existem!');
  console.log('  Nenhuma migração necessária.');
} else {
  console.log(`  ⚠️  Itens faltando:`);
  for (const t of missingTables) console.log(`    - Tabela: ${t}`);
  for (const c of missingColumns) console.log(`    - Coluna: ${c.table}.${c.column || c.detail}`);
  console.log('\n  📋 SQL de migração necessário:');
  console.log('  supabase/migration-incremental.sql');
  console.log('\n  Execute no SQL Editor do Supabase:');
  console.log('  https://supabase.com/dashboard/project/uqthbzqpsgfflljxepen/sql');
}

console.log('═══════════════════════════════════════');

// Also check Supabase Edge Functions
console.log('\n📦 Verificando Edge Functions...');
try {
  const fnUrl = `${SUPA_URL}/functions/v1/process-upload`;
  const r = await fetch(fnUrl, { method: 'OPTIONS', headers: { 'apikey': SVC_KEY } });
  console.log(`  process-upload: status ${r.status} (${r.status === 200 || r.status === 204 ? '✅ exists' : '⚠️ check needed'})`);
} catch (e) {
  console.log(`  process-upload: ❌ ${e.message}`);
}
