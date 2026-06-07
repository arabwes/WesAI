"""Formats numbers for clean, readable tool output."""


def fmt_currency(value: float) -> str:
    return f"${value:,.2f}"


def fmt_pct(value: float, decimals: int = 2) -> str:
    return f"{value:.{decimals}f}%"


def fmt_number(value: float, decimals: int = 0) -> str:
    return f"{value:,.{decimals}f}"


def fmt_table(rows: list, columns: list) -> str:
    if not rows:
        return "(no data)"
    widths = {col: len(col) for col in columns}
    for row in rows:
        for col in columns:
            widths[col] = max(widths[col], len(str(row.get(col, ""))))
    sep = "  ".join("-" * widths[col] for col in columns)
    header = "  ".join(col.ljust(widths[col]) for col in columns)
    lines = [header, sep]
    for row in rows:
        lines.append("  ".join(str(row.get(col, "")).ljust(widths[col]) for col in columns))
    return "\n".join(lines)
