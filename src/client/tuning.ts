// Numbers worth adjusting by feel. Nothing else in the client hard-codes them.

/** How long a live stroke collects points before sending them. Allowed: 30-50 ms. */
export const STROKE_BATCH_MS = 40;

/** perfect-freehand options. https://github.com/steveruizok/perfect-freehand */
export const PEN_SHAPE = { size: 1, thinning: 0.55, smoothing: 0.55, streamline: 0.4 };
export const HIGHLIGHTER_SHAPE = { size: 1, thinning: 0, smoothing: 0.6, streamline: 0.5 };

export const HIGHLIGHTER_WIDTH_FACTOR = 4;
export const HIGHLIGHTER_OPACITY = 0.35;

/** Rounding of stored points, in slide units and pressure units. */
export const COORD_DECIMALS = 1;
export const PRESSURE_DECIMALS = 2;

/** Extra reach of the eraser around the pointer, in slide units. */
export const ERASER_RADIUS = 10;

export const PING_MS = 25_000;
/** With no message for this long, the connection counts as dead. */
export const DEAD_AFTER_MS = 60_000;
export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 15_000;
