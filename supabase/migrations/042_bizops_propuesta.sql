-- ============================================================================
-- 042 · Brief BizOps: propuestas con destino (Tere propone dónde archivar; Pepis acepta o escribe otra carpeta)
-- ============================================================================
ALTER TABLE bizops_items ADD COLUMN IF NOT EXISTS propuesta TEXT;   -- p. ej. ruta propuesta en Kinedu Finance
ALTER TABLE bizops_items ADD COLUMN IF NOT EXISTS respuesta TEXT;   -- lo que Pepis escribió con "✏️ Otra carpeta"
