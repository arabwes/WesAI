"""Initializes the Meta (Facebook) Marketing API session."""
import logging
from facebook_business.api import FacebookAdsApi
from facebook_business.adobjects.adaccount import AdAccount
from config import config

logger = logging.getLogger(__name__)
_initialized = False


def init():
    """Initialize the Meta API session. Safe to call multiple times."""
    global _initialized
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
