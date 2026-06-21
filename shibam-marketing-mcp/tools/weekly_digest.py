"""Composite weekly marketing digest tool — aggregates all key KPIs into one report."""
import logging
from tools.google_ads import google_ads_kpi_check
from tools.meta_ads import meta_ads_kpi_check
from tools.toast_pos import toast_sales_summary, toast_weekend_evening_share
from tools.instagram import instagram_engagement_rate

logger = logging.getLogger(__name__)


async def weekly_marketing_digest(
    week: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Generate a complete weekly marketing digest for Shibam Coffee.

    Calls all KPI checks and sales tools and returns a single formatted report
    with all metrics, 🟢🟡🔴 ratings, and plain-English action items.

    Args:
        week:       date range for the digest — last_7_days | last_30_days | this_month | last_month | custom
                    Defaults to last_7_days.
        start_date: YYYY-MM-DD — required only when week=custom
        end_date:   YYYY-MM-DD — required only when week=custom
    """
    from datetime import date
    from utils.date_helpers import to_start_end

    today = date.today()
    sections = []
    issues = []

    try:
        start, end = to_start_end(week, start_date, end_date)
    except ValueError as e:
        return f"Error: {e}"

    period_label = f"{start} to {end}" if week == "custom" else week
    sections.append(
        f"{'='*60}\n"
        f"  SHIBAM COFFEE — WEEKLY MARKETING DIGEST\n"
        f"  Generated: {today.strftime('%B %d, %Y')}  |  Period: {period_label}\n"
        f"{'='*60}"
    )

    # ── Google Ads ──────────────────────────────────────────────────────
    sections.append("\n📊  GOOGLE ADS\n" + "-" * 40)
    try:
        google_result = await google_ads_kpi_check(date_range="custom", start_date=str(start), end_date=str(end))
        sections.append(google_result)
        if "🔴" in google_result:
            issues.append("Google Ads: one or more KPIs are below target — see Google Ads section above.")
        if "ALERT" in google_result:
            issues.append("Google Ads: immediate alert triggered — check CPC and CTR urgently.")
    except Exception as e:
        sections.append(f"⚠️  Google Ads data unavailable: {e}")
        issues.append("Google Ads data could not be retrieved.")

    # ── Meta Ads ─────────────────────────────────────────────────────────
    sections.append("\n📘  META ADS\n" + "-" * 40)
    try:
        meta_result = await meta_ads_kpi_check(date_range="custom", start_date=str(start), end_date=str(end))
        sections.append(meta_result)
        if "🔴" in meta_result:
            issues.append("Meta Ads: one or more KPIs are below target — see Meta Ads section above.")
        if "ALERT" in meta_result:
            issues.append("Meta Ads: immediate alert triggered — check frequency and CPM urgently.")
    except Exception as e:
        sections.append(f"⚠️  Meta Ads data unavailable: {e}")
        issues.append("Meta Ads data could not be retrieved.")

    # ── Toast Sales ──────────────────────────────────────────────────────
    sections.append("\n☕  TOAST SALES\n" + "-" * 40)
    try:
        toast_result = await toast_sales_summary(str(start), str(end))
        sections.append(toast_result)
    except Exception as e:
        sections.append(f"⚠️  Toast sales data unavailable: {e}")

    # ── Weekend Evening Share ─────────────────────────────────────────────
    sections.append("\n🌙  WEEKEND EVENING SHARE\n" + "-" * 40)
    try:
        weekend_result = await toast_weekend_evening_share(str(start), str(end))
        sections.append(weekend_result)
    except Exception as e:
        sections.append(f"⚠️  Weekend evening data unavailable: {e}")

    # ── Instagram ─────────────────────────────────────────────────────────
    sections.append("\n📸  INSTAGRAM\n" + "-" * 40)
    try:
        ig_result = await instagram_engagement_rate()
        sections.append(ig_result)
        if "🔴" in ig_result:
            issues.append("Instagram engagement rate is below target.")
    except Exception as e:
        sections.append(f"⚠️  Instagram data unavailable: {e}")
        issues.append("Instagram data could not be retrieved.")

    # ── Action Items ──────────────────────────────────────────────────────
    sections.append("\n⚡  ACTION ITEMS THIS WEEK\n" + "-" * 40)
    if issues:
        for i, issue in enumerate(issues, 1):
            sections.append(f"  {i}. {issue}")
    else:
        sections.append("  ✅  All KPIs are on target. No immediate actions required.")

    sections.append(f"\n{'='*60}")
    return "\n".join(sections)
