"""Initializes the Meta (Facebook) Marketing API session."""
import logging
from facebook_business.api import FacebookAdsApi
from facebook_business.adobjects.adaccount import AdAccount
from config import config, NotConfiguredError

logger = logging.getLogger(__name__)
_initialized = False


def init():
    """Initialize the Meta API session. Safe to call multiple times."""
    global _initialized
    if not config.meta_ready:
        raise NotConfiguredError(
            "Meta Ads not configured. Set META_ACCESS_TOKEN, META_APP_ID, and META_APP_SECRET. "
            "Generate a System User Token at business.facebook.com → Business Settings → System Users."
        )
    if not _initialized:
        FacebookAdsApi.init(
            app_id=config.meta_app_id,
            app_secret=config.meta_app_secret,
            access_token=config.meta_access_token,
        )
        _initialized = True
        logger.info("Meta Ads API initialized for account %s", config.meta_ad_account_id)


def get_account() -> AdAccount:
    """Return the AdAccount object for Shibam's ad account."""
    init()
    return AdAccount(config.meta_ad_account_id)
