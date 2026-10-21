-- ============================================================================
-- 040 · Brief BizOps: un solo reporte diario en Slack con lo que Pepis tiene que decidir
-- ============================================================================
-- Los agentes del correo (Oli, Tere, Marco, Quina, Sol, Ciro, Dalia) dejan aquí sus "para ti".
-- Un cron publica a las 9:15 MX un mensaje con botones (Hecho · Mañana · No aplica).
-- Lo que Pepis decide se guarda aquí y los agentes lo leen en su siguiente corrida.
-- Solo la escribe el servidor (service role). No se expone por la anon key.

CREATE TABLE IF NOT EXISTS bizops_items (
  id            BIGSERIAL PRIMARY KEY,
  agente        TEXT NOT NULL,                 -- Oli, Tere, Marco, ...
  ref           TEXT NOT NULL,                 -- id estable del pendiente (thread id de Gmail, folio, etc.)
  texto         TEXT NOT NULL,                 -- una línea, < 120 caracteres, sin datos sensibles
  emoji         TEXT,                          -- ✅ ✍️ 👀 ⏰ 💸 ⚠️ 📁
  prioridad     TEXT NOT NULL DEFAULT 'decide' CHECK (prioridad IN ('urgente', 'decide', 'info')),
  link          TEXT,                          -- link al hilo o al borrador en Gmail
  estado        TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'manana', 'hecho', 'no')),
  decidido_por  TEXT,
  decidido_en   TIMESTAMPTZ,
  primera_vez   DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'America/Mexico_City')::date,
  ultima_vez    DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'America/Mexico_City')::date,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agente, ref)
);
CREATE INDEX IF NOT EXISTS idx_bizops_items_estado ON bizops_items (estado);

-- Una fila por corrida de cada agente: semáforo y si corrió (sirve de tablero de salud).
CREATE TABLE IF NOT EXISTS bizops_runs (
  id          BIGSERIAL PRIMARY KEY,
  agente      TEXT NOT NULL,
  fecha       DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'America/Mexico_City')::date,
  semaforo    TEXT NOT NULL CHECK (semaforo IN ('🟢', '🟡', '🔴')),
  resumen     TEXT,                            -- "2 cosas para ti", "no corrió: falta Gmail"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bizops_runs_fecha ON bizops_runs (fecha DESC, agente);

ALTER TABLE bizops_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE bizops_runs ENABLE ROW LEVEL SECURITY;
