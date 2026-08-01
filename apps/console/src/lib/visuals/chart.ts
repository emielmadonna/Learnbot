const MAX_INPUT_CHARACTERS = 20_000;
const MAX_ROWS = 24;
const MAX_COLUMNS = 5;
const CHART_WIDTH = 960;
const CHART_HEIGHT = 540;
const PLOT = { left: 92, right: 32, top: 72, bottom: 112 };
const COLORS = ["#6C4BFF", "#20A37A", "#E77B35", "#3B82F6"];

export class ChartDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChartDataError";
  }
}

export type ChartAsset = {
  altText: string;
  description: string;
  fileName: string;
  mediaType: "image/svg+xml";
  svg: string;
  title: string;
};
type ChartUnit = "currency" | "number" | "percentage";

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseDelimitedLine(line: string, delimiter: string) {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new ChartDataError("A quoted value is not closed.");
  cells.push(cell.trim());
  return cells;
}

export function parseChartTable(input: string) {
  const normalized = input
    .replace(/^\uFEFF/u, "")
    .trim()
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  if (normalized.length === 0) {
    throw new ChartDataError("Paste a header row and at least one data row.");
  }
  if (normalized.length > MAX_INPUT_CHARACTERS) {
    throw new ChartDataError("Chart data must be 20,000 characters or less.");
  }
  const lines = normalized.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2 || lines.length > MAX_ROWS + 1) {
    throw new ChartDataError("Use a header plus 1–100 data rows.");
  }
  const delimiter = lines[0]!.includes("\t") ? "\t" : ",";
  const rows = lines.map((line) => parseDelimitedLine(line, delimiter));
  const width = rows[0]!.length;
  if (width < 2 || width > MAX_COLUMNS) {
    throw new ChartDataError("Use one label column and 1–4 numeric columns.");
  }
  if (rows.some((row) => row.length !== width)) {
    throw new ChartDataError("Every row must contain the same number of columns.");
  }
  const headers = rows[0]!;
  if (headers.some((header) => header.length < 1 || header.length > 80)) {
    throw new ChartDataError("Every column needs a header of 1–80 characters.");
  }
  const normalizedHeaders = headers.map((header) => header.toLocaleLowerCase());
  if (new Set(normalizedHeaders).size !== normalizedHeaders.length) {
    throw new ChartDataError("Every chart column needs a unique header.");
  }
  const units: Array<ChartUnit | null> = Array.from(
    { length: width - 1 },
    () => null,
  );
  const data = rows.slice(1).map((row) => {
    const label = row[0]!;
    if (label.length < 1 || label.length > 80) {
      throw new ChartDataError("Every row needs a label of 1–80 characters.");
    }
    const values = row.slice(1).map((raw, columnIndex) => {
      const trimmed = raw.trim();
      if (
        trimmed.length === 0 ||
        /^[=+@]/u.test(trimmed) ||
        (trimmed.startsWith("$") && trimmed.endsWith("%")) ||
        !/^\$?(?:0|[1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)(?:\.\d+)?%?$/u.test(
          trimmed,
        )
      ) {
        throw new ChartDataError(
          "Chart cells must contain explicit non-negative numbers.",
        );
      }
      const unit: ChartUnit = trimmed.startsWith("$")
        ? "currency"
        : trimmed.endsWith("%")
          ? "percentage"
          : "number";
      const establishedUnit = units[columnIndex];
      if (establishedUnit !== null && establishedUnit !== unit) {
        throw new ChartDataError(
          "Use one consistent unit in every numeric column.",
        );
      }
      units[columnIndex] = unit;
      const percentage = unit === "percentage";
      const compact = trimmed.replace(/^\$/u, "").replace(/%$/u, "").replaceAll(",", "");
      const value = Number(compact) / (percentage ? 100 : 1);
      if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
        throw new ChartDataError(
          "Chart values must be numbers from 0 to 1,000,000,000.",
        );
      }
      return value;
    });
    return { label, values };
  });
  if (!data.some((row) => row.values.some((value) => value > 0))) {
    throw new ChartDataError("At least one chart value must be greater than zero.");
  }
  const resolvedUnits = units as ChartUnit[];
  if (new Set(resolvedUnits).size > 1) {
    throw new ChartDataError(
      "All series in one chart must use the same unit.",
    );
  }
  return { data, headers, units: resolvedUnits };
}

function compactNumber(value: number, unit: ChartUnit) {
  return new Intl.NumberFormat("en", {
    ...(unit === "currency"
      ? { currency: "USD", style: "currency" as const }
      : unit === "percentage"
        ? { style: "percent" as const }
        : {}),
    maximumFractionDigits: 1,
    notation:
      unit !== "percentage" && value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

export function buildAccessibleBarChart(
  input: string,
  requestedTitle: string,
): ChartAsset {
  const { data, headers, units } = parseChartTable(input);
  const categoryHeader = headers[0];
  const firstSeriesHeader = headers[1];
  const unit = units[0];
  if (
    categoryHeader === undefined ||
    firstSeriesHeader === undefined ||
    unit === undefined
  ) {
    throw new ChartDataError(
      "Use one label column and at least one numeric column.",
    );
  }
  const title =
    requestedTitle.trim().slice(0, 160) ||
    `${firstSeriesHeader} by ${categoryHeader}`;
  const series = headers.slice(1);
  const maximum = Math.max(...data.flatMap((row) => row.values));
  const plotWidth = CHART_WIDTH - PLOT.left - PLOT.right;
  const plotHeight = CHART_HEIGHT - PLOT.top - PLOT.bottom;
  const groupWidth = plotWidth / data.length;
  const barGap = 4;
  const barWidth = Math.max(
    2,
    Math.min(48, (groupWidth * 0.72 - barGap * (series.length - 1)) / series.length),
  );
  const grid = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const y = PLOT.top + plotHeight * (1 - ratio);
    const value = maximum * ratio;
    return `<line x1="${PLOT.left}" y1="${y}" x2="${CHART_WIDTH - PLOT.right}" y2="${y}" stroke="#D9DCE5" stroke-width="1"/><text x="${PLOT.left - 12}" y="${y + 5}" text-anchor="end" font-family="Arial, sans-serif" font-size="13" fill="#5E6472">${xml(compactNumber(value, unit))}</text>`;
  }).join("");
  const bars = data
    .map((row, rowIndex) => {
      const center = PLOT.left + groupWidth * rowIndex + groupWidth / 2;
      const groupStart =
        center -
        (barWidth * series.length + barGap * (series.length - 1)) / 2;
      const rowBars = row.values
        .map((value, seriesIndex) => {
          const height = (value / maximum) * plotHeight;
          const x = groupStart + seriesIndex * (barWidth + barGap);
          const y = PLOT.top + plotHeight - height;
          return `<rect x="${x}" y="${y}" width="${barWidth}" height="${height}" rx="3" fill="${COLORS[seriesIndex]}"><title>${xml(`${row.label}, ${series[seriesIndex]}: ${compactNumber(value, unit)}`)}</title></rect>`;
        })
        .join("");
      const shortLabel =
        row.label.length > 18 ? `${row.label.slice(0, 17)}…` : row.label;
      return `${rowBars}<text x="${center}" y="${PLOT.top + plotHeight + 22}" transform="rotate(-35 ${center} ${PLOT.top + plotHeight + 22})" text-anchor="end" font-family="Arial, sans-serif" font-size="12" fill="#343846">${xml(shortLabel)}</text>`;
    })
    .join("");
  const legend = series
    .map(
      (name, index) =>
        `<rect x="${PLOT.left + index * 190}" y="${CHART_HEIGHT - 40}" width="14" height="14" rx="3" fill="${COLORS[index]}"/><text x="${PLOT.left + 21 + index * 190}" y="${CHART_HEIGHT - 28}" font-family="Arial, sans-serif" font-size="13" fill="#343846">${xml(name)}</text>`,
    )
    .join("");
  const summary = data
    .map(
      (row) =>
        `${row.label}: ${row.values
          .map((value, index) => `${series[index]} ${compactNumber(value, unit)}`)
          .join(", ")}`,
    )
    .join("; ");
  const altText = `${title}. Bar chart. ${summary}`.slice(0, 500);
  const description = `Bar chart comparing ${series.join(", ")} across ${data.length} ${categoryHeader.toLowerCase()} ${data.length === 1 ? "entry" : "entries"}.`;
  const fileStem =
    title
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 80) || "chart";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="${xml(altText)}"><title>${xml(title)}</title><desc>${xml(altText)}</desc><rect x="0" y="0" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" fill="#FFFFFF"/><text x="${PLOT.left}" y="38" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#202330">${xml(title)}</text>${grid}${bars}${legend}</svg>`;
  return {
    altText,
    description,
    fileName: `${fileStem}.svg`,
    mediaType: "image/svg+xml",
    svg,
    title,
  };
}
