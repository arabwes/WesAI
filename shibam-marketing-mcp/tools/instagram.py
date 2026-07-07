"""Instagram Insights MCP tools — 3 tools covering account summary, post performance, and engagement rate."""
import logging
from mcp_common.errors import safe_error
from mcp_common.tenant import maybe_tenant
from clients.instagram_client import get, account_id
from config import NotConfiguredError
from utils.kpi_status import instagram_engagement_status
from utils.formatting import fmt_number, fmt_pct, fmt_table
from utils.retry import api_retry

logger = logging.getLogger(__name__)

# Defaults; overridable per tenant via settings.
_BASELINE_FOLLOWERS = 4735
_GROWTH_TARGET_PCT = 5.0  # ≥5% month-over-month


def _setting(key, default):
    t = maybe_tenant()
    return t.setting(key, default) if t else default


def _baseline_followers() -> int:
    return int(_setting("instagram_follower_baseline", _BASELINE_FOLLOWERS))


def _growth_target_pct() -> float:
    return float(_setting("instagram_growth_target_pct", _GROWTH_TARGET_PCT))


@api_retry()
async def instagram_account_summary() -> str:
    """
    Fetch the connected Instagram business account's summary.

    Returns follower count, following count, media count, and profile views,
    plus growth versus the configured follower baseline and growth target.
    """
    try:
        baseline = _baseline_followers()
        growth_target = _growth_target_pct()
        ig_id = account_id()
        data = get(ig_id, params={
            "fields": "followers_count,follows_count,media_count,name,username,biography"
        })

        followers = data.get("followers_count", 0)
        growth_vs_baseline = followers - baseline
        growth_pct = (growth_vs_baseline / baseline * 100) if baseline else 0

        # Fetch profile views from insights (requires business account)
        profile_views = "—"
        try:
            insights = get(f"{ig_id}/insights", params={
                "metric": "profile_views",
                "period": "day",
                "since": "",
                "until": "",
            })
            profile_views = sum(
                item.get("values", [{}])[-1].get("value", 0)
                for item in insights.get("data", [])
            )
        except Exception:
            pass  # profile_views requires additional permissions; not critical

        lines = [
            f"Instagram Account Summary — @{data.get('username', '')}",
            f"",
            f"Followers:      {fmt_number(followers)}",
            f"Following:      {fmt_number(data.get('follows_count', 0))}",
            f"Total Posts:    {fmt_number(data.get('media_count', 0))}",
            f"Profile Views:  {fmt_number(profile_views) if isinstance(profile_views, int) else profile_views}",
            f"",
            f"Growth vs baseline ({fmt_number(baseline)} followers):",
            f"  Change:  {'+' if growth_vs_baseline >= 0 else ''}{fmt_number(growth_vs_baseline)} followers ({fmt_pct(growth_pct, 1)})",
        ]

        if growth_vs_baseline >= 0:
            if growth_pct >= growth_target:
                lines.append(f"  Status:  🟢  Above {growth_target}% MoM growth target")
            else:
                lines.append(f"  Status:  🔴  Below {growth_target}% MoM growth target (need +{fmt_number(round(baseline * growth_target / 100 - growth_vs_baseline))} more followers)")

        return "\n".join(lines)

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "fetching Instagram account summary")


@api_retry()
async def instagram_post_performance(limit: int = 20) -> str:
    """
    Fetch performance metrics for the last N Instagram posts.

    Returns media type, timestamp, likes, comments, reach, impressions,
    and engagement rate for each post. Sorted by engagement rate descending.

    Args:
        limit: number of recent posts to fetch (default 20, max 50)
    """
    try:
        limit = min(max(1, limit), 50)
        ig_id = account_id()

        # Get recent media
        media_data = get(f"{ig_id}/media", params={
            "fields": "id,media_type,timestamp,like_count,comments_count,caption",
            "limit": limit,
        })
        media_items = media_data.get("data", [])

        if not media_items:
            return "No Instagram posts found."

        # Get account followers for engagement rate calculation
        account_data = get(ig_id, params={"fields": "followers_count"})
        followers = account_data.get("followers_count", _baseline_followers())

        rows = []
        for item in media_items:
            media_id = item["id"]
            likes = item.get("like_count", 0)
            comments = item.get("comments_count", 0)
            timestamp = item.get("timestamp", "")[:10]
            media_type = item.get("media_type", "")

            # Fetch reach and impressions from insights
            reach = impressions = 0
            try:
                insights = get(f"{media_id}/insights", params={
                    "metric": "reach,impressions"
                })
                for metric in insights.get("data", []):
                    if metric["name"] == "reach":
                        reach = metric.get("values", [{}])[0].get("value", 0)
                    elif metric["name"] == "impressions":
                        impressions = metric.get("values", [{}])[0].get("value", 0)
            except Exception:
                pass  # Insights require specific permissions; gracefully skip

            eng_rate = ((likes + comments) / followers * 100) if followers else 0
            rows.append({
                "Date": timestamp,
                "Type": media_type,
                "Likes": fmt_number(likes),
                "Comments": fmt_number(comments),
                "Reach": fmt_number(reach) if reach else "—",
                "Impr": fmt_number(impressions) if impressions else "—",
                "Eng Rate": fmt_pct(eng_rate),
                "_eng_raw": eng_rate,
            })

        rows.sort(key=lambda x: -x["_eng_raw"])
        for r in rows:
            del r["_eng_raw"]

        cols = ["Date", "Type", "Likes", "Comments", "Reach", "Impr", "Eng Rate"]
        return (
            f"Instagram Post Performance — last {len(rows)} posts (sorted by engagement rate)\n\n"
            + fmt_table(rows, cols)
        )

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "fetching Instagram post performance")


@api_retry()
async def instagram_engagement_rate() -> str:
    """
    Calculate average engagement rate across the last 30 Instagram posts vs the ≥3% KPI target.

    Formula: (likes + comments) / followers × 100

    Returns 🟢🟡🔴 status.
    """
    try:
        ig_id = account_id()

        media_data = get(f"{ig_id}/media", params={
            "fields": "id,like_count,comments_count",
            "limit": 30,
        })
        media_items = media_data.get("data", [])

        account_data = get(ig_id, params={"fields": "followers_count"})
        followers = account_data.get("followers_count", _baseline_followers())

        if not media_items:
            return "No Instagram posts found to calculate engagement rate."

        eng_rates = []
        for item in media_items:
            likes = item.get("like_count", 0)
            comments = item.get("comments_count", 0)
            rate = ((likes + comments) / followers * 100) if followers else 0
            eng_rates.append(rate)

        avg_rate = sum(eng_rates) / len(eng_rates)
        s = instagram_engagement_status(avg_rate)

        lines = [
            f"Instagram Engagement Rate — last {len(eng_rates)} posts",
            f"",
            f"{s}  Average Engagement Rate:  {fmt_pct(avg_rate)}  (target: ≥3%)",
            f"",
            f"Highest post:   {fmt_pct(max(eng_rates))}",
            f"Lowest post:    {fmt_pct(min(eng_rates))}",
            f"Followers used: {fmt_number(followers)}",
            f"",
            f"Formula: (likes + comments) / followers × 100",
        ]

        if avg_rate < 1.5:
            lines.append("\n⚠️  Engagement rate is critically low. Consider reviewing posting frequency, content type, and hashtag strategy.")
        elif avg_rate < 3.0:
            lines.append("\n🟡  Engagement rate is below target. Review recent top-performing posts for patterns to replicate.")

        return "\n".join(lines)

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "calculating Instagram engagement rate")
