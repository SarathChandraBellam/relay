"""Server-side tools for the demo agent.

`lookup_order` runs freely. `issue_refund` is gated behind human approval
(see `interrupt_on` in graph.py), which is what exercises the park/resume path
in the runner.
"""

from langchain_core.tools import tool

_ORDERS = {
    "A-1001": {"item": "Mechanical keyboard", "total": 129.0, "status": "delivered"},
    "A-1002": {"item": "USB-C dock", "total": 89.5, "status": "in transit"},
    "A-1003": {"item": "27-inch monitor", "total": 349.0, "status": "delivered"},
}


@tool
def lookup_order(order_id: str) -> dict:
    """Look up an order by id (for example A-1001)."""
    order = _ORDERS.get(order_id.upper())
    if order is None:
        return {"found": False, "order_id": order_id}
    return {"found": True, "order_id": order_id.upper(), **order}


@tool
def issue_refund(order_id: str, amount: float) -> dict:
    """Refund an amount on an order. Requires human approval before it runs."""
    return {"refunded": True, "order_id": order_id.upper(), "amount": amount}


TOOLS = [lookup_order, issue_refund]
