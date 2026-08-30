"""In-memory MCP mock for agentic commerce demonstrations."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from itertools import count
from pathlib import Path
import sys
from typing import Any
from uuid import uuid4

# This project intentionally calls the entrypoint ``mcp.py``. Exclude its
# directory briefly so that this import resolves the installed MCP SDK rather
# than this file itself when the server is launched with ``python3 mcp.py``.
_PROJECT_DIRECTORY = Path(__file__).resolve().parent
_ORIGINAL_SYS_PATH = sys.path.copy()
sys.path = [path for path in sys.path if Path(path or ".").resolve() != _PROJECT_DIRECTORY]
try:
    from mcp.server.fastmcp import FastMCP
except ModuleNotFoundError:
    # MCP SDK 2.x renamed FastMCP while keeping the tool-server interface.
    from mcp.server.mcpserver import MCPServer as FastMCP
sys.path = _ORIGINAL_SYS_PATH


mcp = FastMCP("mock-y2a")


# Master inventory. Item IDs are intentionally shared between merchants so a
# catalog search can compare the same item sold by different sellers.
ITEMS_BY_CATEGORY: dict[str, dict[str, dict[str, Any]]] = {
    "food": {
        "food-coffee-beans-1kg": {"name": "Coffee beans, 1 kg", "price_usd": 18.50},
        "food-pasta-pack": {"name": "Pasta variety pack", "price_usd": 8.90},
        "food-grocery-basket": {"name": "Weekly grocery basket", "price_usd": 42.00},
        "food-olive-oil-1l": {"name": "Extra virgin olive oil, 1 L", "price_usd": 15.25},
        "food-chocolate-box": {"name": "Artisan chocolate box", "price_usd": 12.40},
        "food-sparkling-water": {"name": "Sparkling water, 12-pack", "price_usd": 9.75},
        "food-protein-bar": {"name": "Protein bar box", "price_usd": 22.80},
        "food-tea-selection": {"name": "Premium tea selection", "price_usd": 14.60},
    },
    "clothing": {
        "clothing-cotton-tshirt": {"name": "Organic cotton T-shirt", "price_usd": 24.00},
        "clothing-denim-jeans": {"name": "Classic denim jeans", "price_usd": 59.00},
        "clothing-running-shoes": {"name": "Everyday running shoes", "price_usd": 84.00},
        "clothing-hoodie": {"name": "Fleece hoodie", "price_usd": 48.00},
        "clothing-linen-shirt": {"name": "Linen button-down shirt", "price_usd": 52.50},
        "clothing-leather-belt": {"name": "Leather belt", "price_usd": 32.00},
        "clothing-winter-jacket": {"name": "Water-resistant winter jacket", "price_usd": 129.00},
        "clothing-canvas-tote": {"name": "Canvas tote bag", "price_usd": 19.00},
    },
    "travel": {
        "travel-flight-bue-cor": {"name": "Flight Buenos Aires to Córdoba", "price_usd": 132.00},
        "travel-flight-bue-scl": {"name": "Flight Buenos Aires to Santiago", "price_usd": 168.00},
        "travel-flight-bue-lim": {"name": "Flight Buenos Aires to Lima", "price_usd": 241.00},
        "travel-hotel-bue-night": {"name": "Buenos Aires hotel, one night", "price_usd": 96.00},
        "travel-hotel-cor-night": {"name": "Córdoba hotel, one night", "price_usd": 72.00},
        "travel-city-pass": {"name": "Buenos Aires city pass", "price_usd": 29.00},
        "travel-car-rental-day": {"name": "Economy car rental, one day", "price_usd": 44.00},
        "travel-luggage-20kg": {"name": "Checked luggage, 20 kg", "price_usd": 38.00},
    },
    "electronics": {
        "electronics-headphones": {"name": "Noise-cancelling headphones", "price_usd": 199.00},
        "electronics-keyboard": {"name": "Wireless mechanical keyboard", "price_usd": 109.00},
        "electronics-monitor": {"name": "27-inch 4K monitor", "price_usd": 329.00},
        "electronics-webcam": {"name": "1080p webcam", "price_usd": 69.00},
        "electronics-usb-c-hub": {"name": "USB-C multiport hub", "price_usd": 54.00},
        "electronics-speaker": {"name": "Portable Bluetooth speaker", "price_usd": 79.00},
        "electronics-smartwatch": {"name": "Fitness smartwatch", "price_usd": 179.00},
        "electronics-ereader": {"name": "E-reader with front light", "price_usd": 139.00},
    },
    "subscriptions": {
        "subscriptions-music-monthly": {"name": "Music Plus, monthly", "price_usd": 10.99},
        "subscriptions-video-monthly": {"name": "StreamBox, monthly", "price_usd": 14.99},
        "subscriptions-cloud-monthly": {"name": "Cloud storage, 2 TB monthly", "price_usd": 11.99},
        "subscriptions-news-yearly": {"name": "Digital news, yearly", "price_usd": 89.00},
        "subscriptions-fitness-monthly": {"name": "Fitness app, monthly", "price_usd": 12.99},
        "subscriptions-language-monthly": {"name": "Language learning, monthly", "price_usd": 13.99},
        "subscriptions-productivity-monthly": {"name": "Productivity suite, monthly", "price_usd": 15.00},
        "subscriptions-design-monthly": {"name": "Design library, monthly", "price_usd": 18.00},
    },
    "games": {
        "games-galaxy-quest": {"name": "Galaxy Quest", "price_usd": 59.99},
        "games-racing-legends": {"name": "Racing Legends", "price_usd": 49.99},
        "games-strategy-kingdom": {"name": "Strategy Kingdom", "price_usd": 39.99},
        "games-indie-bundle": {"name": "Indie discovery bundle", "price_usd": 24.99},
        "games-controller": {"name": "Wireless game controller", "price_usd": 64.99},
        "games-season-pass": {"name": "Adventure season pass", "price_usd": 19.99},
        "games-gift-card-25": {"name": "Gaming store gift card, $25", "price_usd": 25.00},
        "games-vr-puzzle": {"name": "VR Puzzle World", "price_usd": 29.99},
    },
}

# Prices are deliberately removed from the product master. The price visible
# to clients lives exclusively in each entry of MERCHANT_CATALOGS below.
for _category_items in ITEMS_BY_CATEGORY.values():
    for _item in _category_items.values():
        _item.pop("price_usd")


# Every catalog entry owns its price and currency. The master item inventory is
# only used to identify products; it never determines the price returned to a
# client. Each category has 18 merchants, for a total of 108 sellers.
MERCHANT_CATALOGS: dict[str, list[dict[str, Any]]] = {}
MERCHANTS: dict[str, dict[str, Any]] = {}
_CURRENCY_PER_USD = {"USD": 1.0, "EUR": 0.92, "ARS": 900.0, "GBP": 0.79}
_CURRENCIES = tuple(_CURRENCY_PER_USD)
MERCHANT_NAMES = {
    "food": ["Green Basket", "Harvest Pantry", "Bean & Barrel", "Olive Market", "Fresh Fork", "Daily Provisions", "The Corner Grocer", "Golden Apron", "Cedar Foods", "Local Larder", "Morning Roasters", "Bright Orchard", "Urban Harvest", "Pasta House", "Tea Garden", "Good Grain", "Mercado Central", "The Honest Cart"],
    "clothing": ["Thread & Needle", "Canvas Wardrobe", "Northline Apparel", "Cotton District", "Everyday Outfitters", "Blue Stitch", "Linen Lane", "Streetwear Supply", "Summit Outerwear", "The Shoe Room", "Tailored Basics", "Harbor Denim", "Modern Hanger", "Willow Wear", "Fit & Form", "Common Thread", "The Garment Club", "Weekend Wardrobe"],
    "travel": ["Andes Air", "Southern Skies", "Pampa Airways", "Horizon Flights", "Rio Travel", "Cloudline Air", "Patagonia Routes", "AeroCentro", "Waypoint Travel", "Córdoba Connect", "Latitude Getaways", "Atlas Escapes", "Terminal One", "Blue Map Travel", "Vista Voyages", "CityHop", "Sunset Airlines", "Roam & Rest"],
    "electronics": ["Circuit Corner", "Bright Pixel", "Signal Shop", "Volt House", "Future Devices", "Desktop Depot", "Audio Avenue", "Screen Society", "Tech Harbor", "Plug & Play", "Nova Electronics", "Gadget Grove", "Byte Market", "The Device Desk", "Current Supply", "Pixel Point", "Connected Home", "Silicon Street"],
    "subscriptions": ["Soundwave Plus", "Stream Harbor", "Cloudnest", "Readwell Digital", "Daily Focus", "Fit Routine", "Lingua Loop", "Creator Suite", "Watchlist", "Storage Works", "The Learning Room", "Mindful Minutes", "Playbook Pro", "Newsroom Direct", "Studio Pass", "Habit Hub", "Plan Better", "Member Circle"],
    "games": ["Quest Arcade", "Pixel Portal", "Level Up Games", "Critical Hit", "Joypad Junction", "Game Night", "Respawn Store", "Indie Island", "Arcade Avenue", "Save Point", "Next Level", "Controller Club", "Playfield", "Virtual Vault", "Co-op Corner", "Retro Rocket", "The Game Shelf", "Checkpoint"],
}

# These are catalog-construction starting points, not item prices. The final
# price is stored only in the offer selected for each merchant catalog.
_OFFER_PRICE_GUIDES = {
    "food": [18.5, 8.9, 42.0, 15.25, 12.4, 9.75, 22.8, 14.6],
    "clothing": [24.0, 59.0, 84.0, 48.0, 52.5, 32.0, 129.0, 19.0],
    "travel": [132.0, 168.0, 241.0, 96.0, 72.0, 29.0, 44.0, 38.0],
    "electronics": [199.0, 109.0, 329.0, 69.0, 54.0, 79.0, 179.0, 139.0],
    "subscriptions": [10.99, 14.99, 11.99, 89.0, 12.99, 13.99, 15.0, 18.0],
    "games": [59.99, 49.99, 39.99, 24.99, 64.99, 19.99, 25.0, 29.99],
}


def _build_merchants() -> None:
    for category, items in ITEMS_BY_CATEGORY.items():
        item_ids = list(items)
        for index, merchant_name in enumerate(MERCHANT_NAMES[category], start=1):
            merchant_id = f"{category}-merchant-{index:02d}"
            currency = _CURRENCIES[(index - 1) % len(_CURRENCIES)]
            price_multiplier = 0.90 + ((index * 7) % 20) / 100
            offered_items = [item_ids[(index - 1 + offset) % len(item_ids)] for offset in range(5)]
            MERCHANTS[merchant_id] = {
                "name": merchant_name,
                "category": category,
            }
            MERCHANT_CATALOGS[merchant_id] = [
                {
                    "item_id": item_id,
                    "price": round(_OFFER_PRICE_GUIDES[category][(index - 1 + slot) % len(item_ids)] * price_multiplier * _CURRENCY_PER_USD[currency], 2),
                    "currency": currency,
                    "price_usd": round(_OFFER_PRICE_GUIDES[category][(index - 1 + slot) % len(item_ids)] * price_multiplier, 2),
                }
                for slot, item_id in enumerate(offered_items)
            ]


_build_merchants()


def _find_item(item_id: str) -> tuple[str, dict[str, Any]] | None:
    for category, items in ITEMS_BY_CATEGORY.items():
        if item_id in items:
            return category, items[item_id]
    return None


def _offer(merchant_id: str, merchant_offer: dict[str, Any]) -> dict[str, Any]:
    item_id = merchant_offer["item_id"]
    found = _find_item(item_id)
    if found is None:
        raise ValueError(f"Unknown item ID: {item_id}")
    category, item = found
    merchant = MERCHANTS[merchant_id]
    return {
        "item_id": item_id,
        "item": item["name"],
        "category": category,
        "merchant_id": merchant_id,
        "merchant": merchant["name"],
        "price": merchant_offer["price"],
        "currency": merchant_offer["currency"],
        "price_usd": merchant_offer["price_usd"],
    }


def _catalog_results(query: str) -> list[dict[str, Any]]:
    normalized = query.strip().lower()
    if not normalized:
        return []

    results: list[dict[str, Any]] = []
    for merchant_id, merchant_offers in MERCHANT_CATALOGS.items():
        for merchant_offer in merchant_offers:
            item_id = merchant_offer["item_id"]
            category, item = _find_item(item_id) or ("", {})
            searchable = f"{item_id} {item.get('name', '')} {category}".lower()
            if normalized in searchable:
                results.append(_offer(merchant_id, merchant_offer))

    return sorted(results, key=lambda offer: (offer["price_usd"], offer["merchant"]))


@mcp.tool()
def catalog(item: str) -> dict[str, Any]:
    """Find item offers across merchants.

    `item` accepts an item ID, name fragment, or category. Results include the
    item name, merchant, price, and currency; they are sorted by normalized USD
    price so mixed-currency offers remain comparable.
    """

    offers = _catalog_results(item)
    return {
        "query": item,
        "offer_count": len(offers),
        "offers": [{key: value for key, value in offer.items() if key != "price_usd"} for offer in offers],
    }


TRANSACTIONS: dict[str, dict[str, Any]] = {}
_transaction_sequence = count(1)
_buy_attempt_sequence = count(1)
_SUCCESS_LOG_TEMPLATE = [
    ("fetch_from_catalog", "success", 0),
    ("mandate_check", "success", 120),
    ("payment", "success", 260),
]
_FAILURE_LOG_TEMPLATE = [
    ("fetch_from_catalog", "success", 0),
    ("mandate_check", "fail", 120),
]


@mcp.tool()
def buy(item: str) -> dict[str, Any]:
    """Record a purchase attempt using the mock mandate rule.

    The first call after the MCP server starts is successful. Every later call
    fails with ``Mandate failure``. A transaction log entry is created for
    every call, including a failed or unmatched purchase attempt.
    """

    offers = _catalog_results(item)
    transaction_id = f"txn_{next(_transaction_sequence):06d}_{uuid4().hex[:8]}"
    is_first_attempt = next(_buy_attempt_sequence) == 1
    transaction = {
        "transaction_id": transaction_id,
        "timestamp": datetime.now(UTC).isoformat(),
        "requested_item": item,
        "exit_status": "successful" if is_first_attempt else "failure",
        "feedback": "Purchase approved" if is_first_attempt else "Mandate failure",
    }

    if offers:
        transaction.update(
            {
                "selection_policy": "lowest_normalized_usd_price",
                **{key: value for key, value in offers[0].items() if key != "price_usd"},
            }
        )
    else:
        transaction["catalog_match"] = False

    TRANSACTIONS[transaction_id] = transaction
    return transaction


@mcp.tool()
def log(transaction_id: str) -> dict[str, Any]:
    """Return the placeholder execution log for a transaction ID.

    Successful transactions include catalog fetch, mandate check, and payment.
    Failed transactions stop at the failing mandate check and never include a
    payment entry.
    """

    transaction = TRANSACTIONS.get(transaction_id)
    if transaction is None:
        return {"status": "not_found", "message": f"No transaction exists with ID '{transaction_id}'."}

    started_at = datetime.fromisoformat(transaction["timestamp"])
    template = _SUCCESS_LOG_TEMPLATE if transaction["exit_status"] == "successful" else _FAILURE_LOG_TEMPLATE
    entries = [
        {
            "timestamp": (started_at + timedelta(milliseconds=offset)).isoformat(),
            "operation": operation,
            "status": status,
        }
        for operation, status, offset in template
    ]
    return {
        "transaction_id": transaction_id,
        "exit_status": transaction["exit_status"],
        "entries": entries,
    }


if __name__ == "__main__":
    mcp.run()
