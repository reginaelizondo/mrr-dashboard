-- ============================================================================
-- 027 · Estela: propuestas semanales con impacto en caja y su seguimiento
-- ============================================================================
-- Estela (agente de BizOps) publica cada lunes tres propuestas en Slack.
-- Esta tabla guarda cada propuesta y lo que Pepis decidió (botones del mensaje),
-- para que la siguiente semana Estela dé seguimiento en vez de repetir.
-- Solo la escribe el servidor (service role). No se expone por la anon key.

CREATE TABLE IF NOT EXISTS estela_proposals (
  id               BIGSERIAL PRIMARY KEY,
  week_start       DATE NOT NULL,                 -- lunes de la semana en que se propuso
  titulo           TEXT NOT NULL,
  que              TEXT NOT NULL,
  impacto_cash     TEXT,                          -- '+$4,500/mes', tal como se publicó
  como_se_calculo  TEXT,
  riesgo           TEXT,
  cuando_se_ve     TEXT,
  dueno            TEXT,
  tipo             TEXT,                          -- ahorro · ingreso · cobranza · riesgo · pricing · otro
  estado           TEXT NOT NULL DEFAULT 'propuesta'
                   CHECK (estado IN ('propuesta', 'aceptada', 'rechazada', 'cerrada')),
  decidido_por     TEXT,
  decidido_en      TIMESTAMPTZ,
  resultado        TEXT,                          -- qué pasó al final (lo llena Pepis o Estela)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_estela_proposals_week ON estela_proposals (week_start DESC);
CREATE INDEX IF NOT EXISTS idx_estela_proposals_estado ON estela_proposals (estado);

ALTER TABLE estela_proposals ENABLE ROW LEVEL SECURITY;
-- Sin políticas: solo el service role (servidor) lee y escribe.
