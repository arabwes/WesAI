"""Google Ads MCP tools — 5 tools covering campaign performance, spend, KPIs, assets, and impression share."""
import logging
from typing import Optional
from mcp_common.errors import safe_error
from mcp_common.validators import gaql_date
from mcp_common.tenant import maybe_tenant
from clients.google_ads_client import run_query
from config import NotConfiguredError
from utils.date_helpers import to_start_end
from utils.kpi_status import (
    google_ctr_status, google_cpc_status,
    google_conv_rate_status, google_cost_per_conv_status,
    google_impression_share_status, alert,
)
from utils.formatting import fmt_currency, fmt_pct, fmt_number, fmt_table
from utils.retry import api_retry

logger = logging.getLogger(__name__)


def _setting(key, default):
    t = maybe_tenant()
    return t.setting(key, default) if t else default


@api_retry()
async def google_ads_campaign_performance(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Fetch Google Ads campaign performance metrics.

    Returns campaign name, impressions, clicks, CTR, average CPC,
    conversions, cost, and conversion rate for each active campaign.

    Args:
        date_range: last_7_days | last_30_days | this_month | last_month | custom
        start_date: YYYY-MM-DD — required only when date_range=custom
        end_date:   YYYY-MM-DD — required only when date_range=custom
    """
    try:
        start, end = to_start_end(date_range, start_date, end_date)
        query = f"""
            SELECT
                campaign.name,
                campaign.status,
                metrics.impressions,
                metrics.clicks,
                metrics.ctr,
                metrics.average_cpc,
                metrics.conversions,
                metrics.cost_micros,
                metrics.conversions_from_interactions_rate
            FROM campaign
            WHERE segments.date BETWEEN '{gaql_date(start)}' AND '{gaql_date(end)}'
              AND campaign.status = 'ENABLED'
            ORDER BY metrics.cost_micros DESC
        """
        rows = run_query(query)
        if not rows:
            return f"No active campaigns found for {date_range}."

        table_rows = []
        for row in rows:
            m = row.metrics
            cost = m.cost_micros / 1_000_000
            ctr_pct = m.ctr * 100
            cpc = m.average_cpc / 1_000_000
            conv_rate = m.conversions_from_interactions_rate * 100
            table_rows.append({
                "Campaign": row.campaign.name,
                "Impressions": fmt_number(m.impressions),
                "Clicks": fmt_number(m.clicks),
                "CTR": fmt_pct(ctr_pct),
                "Avg CPC": fmt_currency(cpc),
                "Conversions": fmt_number(m.conversions, 1),
                "Cost": fmt_currency(cost),
                "Conv Rate": fmt_pct(conv_rate),
            })

        cols = ["Campaign", "Impressions", "Clicks", "CTR", "Avg CPC", "Conversions", "Cost", "Conv Rate"]
        header = f"Google Ads Campaign Performance — {date_range} ({start} to {end})\n\n"
        return header + fmt_table(table_rows, cols)

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "fetching Google Ads campaign performance")


@api_retry()
async def google_ads_spend_summary(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Fetch total Google Ads spend broken down by campaign type (Search vs PMAX).

    Also estimates remaining monthly budget based on daily spend rate.

    Args:
        date_range: last_7_days | last_30_days | this_month | last_month | custom
        start_date: YYYY-MM-DD — required only when date_range=custom
        end_date:   YYYY-MM-DD — required only when date_range=custom
    """
    try:
        start, end = to_start_end(date_range, start_date, end_date)
        query = f"""
            SELECT
                campaign.advertising_channel_type,
                metrics.cost_micros,
                metrics.impressions,
                metrics.clicks
            FROM campaign
            WHERE segments.date BETWEEN '{gaql_date(start)}' AND '{gaql_date(end)}'
              AND campaign.status = 'ENABLED'
        """
        rows = run_query(query)

        spend_by_type: dict = {}
        total_spend = 0.0
        for row in rows:
            channel = str(row.campaign.advertising_channel_type.name)
            cost = row.metrics.cost_micros / 1_000_000
            spend_by_type[channel] = spend_by_type.get(channel, 0.0) + cost
            total_spend += cost

        days_in_range = (end - start).days + 1
        daily_rate = total_spend / max(days_in_range, 1)
        from datetime import date
        days_left_in_month = (date.today().replace(month=date.today().month % 12 + 1, day=1)
                              if date.today().month < 12
                              else date.today().replace(year=date.today().year + 1, month=1, day=1)
                              ).__class__(date.today().year, date.today().month + 1 if date.today().month < 12 else 1, 1) if False else None
        from calendar import monthrange
        today = date.today()
        _, days_in_month = monthrange(today.year, today.month)
        days_remaining = days_in_month - today.day
        projected_remaining_spend = daily_rate * days_remaining

        lines = [
            f"Google Ads Spend Summary — {date_range} ({start} to {end})",
            f"",
            f"Total Spend:        {fmt_currency(total_spend)}",
            f"Daily Average:      {fmt_currency(daily_rate)}",
            f"",
            f"Spend by Campaign Type:",
        ]
        for channel_type, spend in sorted(spend_by_type.items(), key=lambda x: -x[1]):
            pct = (spend / total_spend * 100) if total_spend else 0
            lines.append(f"  {channel_type:<20} {fmt_currency(spend)}  ({fmt_pct(pct, 1)} of total)")

        lines += [
            f"",
            f"Projected remaining spend this month ({days_remaining} days left): {fmt_currency(projected_remaining_spend)}",
            f"Monthly budget target: {_setting('kpi_budget_range', '$800–$1,200')}",
        ]
        return "\n".join(lines)

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "fetching Google Ads spend summary")


@api_retry()
async def google_ads_kpi_check(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Check Google Ads KPIs against configured targets and return 🟢🟡🔴 status per metric.

    Targets:
      CTR:               🟢 ≥5%   / 🟡 3–5%   / 🔴 <3%
      CPC:               🟢 ≤$1.50 / 🟡 $1.50–$2.00 / 🔴 >$2.00
      Conversion rate:   🟢 ≥8%   / 🟡 5–8%   / 🔴 <5%
      Cost/conversion:   🟢 ≤$4   / 🟡 $4–$6  / 🔴 >$6

    Immediate alerts: CPC >$2.00, CTR <3%

    Args:
        date_range: last_7_days | last_30_days | this_month | last_month | custom
        start_date: YYYY-MM-DD — required only when date_range=custom
        end_date:   YYYY-MM-DD — required only when date_range=custom
    """
    try:
        start, end = to_start_end(date_range, start_date, end_date)
        query = f"""
            SELECT
                metrics.impressions,
                metrics.clicks,
                metrics.ctr,
                metrics.average_cpc,
                metrics.conversions,
                metrics.cost_micros,
                metrics.conversions_from_interactions_rate,
                metrics.cost_per_conversion
            FROM customer
            WHERE segments.date BETWEEN '{gaql_date(start)}' AND '{gaql_date(end)}'
        """
        rows = run_query(query)
        if not rows:
            return "No data available for the selected date range."

        # Aggregate across all rows (customer-level query returns one row per day)
        total_impressions = sum(r.metrics.impressions for r in rows)
        total_clicks = sum(r.metrics.clicks for r in rows)
        total_cost = sum(r.metrics.cost_micros for r in rows) / 1_000_000
        total_conversions = sum(r.metrics.conversions for r in rows)

        ctr_pct = (total_clicks / total_impressions * 100) if total_impressions else 0
        avg_cpc = (total_cost / total_clicks) if total_clicks else 0
        conv_rate_pct = (total_conversions / total_clicks * 100) if total_clicks else 0
        cost_per_conv = (total_cost / total_conversions) if total_conversions else 0

        alerts = []
        if avg_cpc > 2.00:
            alerts.append(alert(True, f"CPC is {fmt_currency(avg_cpc)} — exceeds $2.00 immediate alert threshold"))
        if ctr_pct < 3.0:
            alerts.append(alert(True, f"CTR is {fmt_pct(ctr_pct)} — below 3% immediate alert threshold"))

        lines = [
            f"Google Ads KPI Check — {date_range} ({start} to {end})",
            f"",
            f"{google_ctr_status(ctr_pct)}  CTR:              {fmt_pct(ctr_pct)}   (target: ≥5%)",
            f"{google_cpc_status(avg_cpc)}  Avg CPC:          {fmt_currency(avg_cpc)}  (target: ≤$1.50)",
            f"{google_conv_rate_status(conv_rate_pct)}  Conversion Rate:  {fmt_pct(conv_rate_pct)}   (target: ≥8%)",
            f"{google_cost_per_conv_status(cost_per_conv)}  Cost/Conversion:  {fmt_currency(cost_per_conv)}  (target: ≤$4.00)",
            f"",
            f"Volume:  {fmt_number(total_impressions)} impressions / {fmt_number(total_clicks)} clicks / {fmt_number(total_conversions, 1)} conversions / {fmt_currency(total_cost)} spent",
        ]
        if alerts:
            lines += ["", "ALERTS:"] + [f"  {a}" for a in alerts if a]

        return "\n".join(lines)

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "checking Google Ads KPIs")


@api_retry()
async def google_ads_asset_review() -> str:
    """
    Review all active ad assets (headlines and descriptions) across campaigns.

    Flags assets with approval issues or LOW performance ratings.
    No parameters needed — scans all active campaigns automatically.
    """
    try:
        query = """
            SELECT
                campaign.name,
                ad_group.name,
                ad_group_ad.ad.responsive_search_ad.headlines,
                ad_group_ad.ad.responsive_search_ad.descriptions,
                ad_group_ad.policy_summary.approval_status,
                ad_group_ad.policy_summary.review_status,
                ad_group_ad.ad_strength
            FROM ad_group_ad
            WHERE ad_group_ad.status = 'ENABLED'
              AND campaign.status = 'ENABLED'
              AND ad_group.status = 'ENABLED'
        """
        rows = run_query(query)
        if not rows:
            return "No active ads found."

        flagged = []
        all_ads = []
        for row in rows:
            ad = row.ad_group_ad
            approval = str(ad.policy_summary.approval_status.name)
            strength = str(ad.ad_strength.name) if hasattr(ad, "ad_strength") else "UNKNOWN"
            issues = []
            if approval not in ("APPROVED", "APPROVED_LIMITED"):
                issues.append(f"Approval: {approval}")
            if strength in ("POOR", "AVERAGE"):
                issues.append(f"Ad Strength: {strength}")

            entry = {
                "Campaign": row.campaign.name,
                "Ad Group": row.ad_group.name,
                "Approval": approval,
                "Strength": strength,
                "Issues": ", ".join(issues) if issues else "None",
            }
            all_ads.append(entry)
            if issues:
                flagged.append(entry)

        lines = [f"Google Ads Asset Review — {len(all_ads)} active ads scanned", ""]
        if flagged:
            lines.append(f"⚠️  {len(flagged)} ads flagged for issues:\n")
            lines.append(fmt_table(flagged, ["Campaign", "Ad Group", "Approval", "Strength", "Issues"]))
        else:
            lines.append("✅  All active ads are approved with no performance warnings.")

        return "\n".join(lines)

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "reviewing Google Ads assets")


@api_retry()
async def google_ads_impression_share(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Fetch local search impression share, lost IS (budget), and lost IS (rank).

    Target: ≥60% impression share.

    Args:
        date_range: last_7_days | last_30_days | this_month | last_month | custom
        start_date: YYYY-MM-DD — required only when date_range=custom
        end_date:   YYYY-MM-DD — required only when date_range=custom
    """
    try:
        start, end = to_start_end(date_range, start_date, end_date)
        query = f"""
            SELECT
                campaign.name,
                campaign.advertising_channel_type,
                metrics.search_impression_share,
                metrics.search_budget_lost_impression_share,
                metrics.search_rank_lost_impression_share
            FROM campaign
            WHERE segments.date BETWEEN '{gaql_date(start)}' AND '{gaql_date(end)}'
              AND campaign.status = 'ENABLED'
              AND campaign.advertising_channel_type = 'SEARCH'
        """
        rows = run_query(query)
        if not rows:
            return "No Search campaigns found for impression share data."

        lines = [f"Google Ads Impression Share — {date_range} ({start} to {end})", ""]
        for row in rows:
            m = row.metrics
            is_pct = m.search_impression_share * 100
            lost_budget = m.search_budget_lost_impression_share * 100
            lost_rank = m.search_rank_lost_impression_share * 100
            s = google_impression_share_status(is_pct)
            lines += [
                f"Campaign: {row.campaign.name}",
                f"  {s}  Impression Share:      {fmt_pct(is_pct)}  (target: ≥60%)",
                f"  📉  Lost IS (Budget):      {fmt_pct(lost_budget)}",
                f"  📉  Lost IS (Rank):        {fmt_pct(lost_rank)}",
                "",
            ]

        if any(row.metrics.search_impression_share * 100 < 40 for row in rows):
            lines.append("⚠️  One or more campaigns have critically low impression share — review budget and bid settings.")

        return "\n".join(lines)

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "fetching Google Ads impression share")
