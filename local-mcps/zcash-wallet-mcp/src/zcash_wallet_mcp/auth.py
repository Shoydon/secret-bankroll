import hmac

from starlette.types import ASGIApp, Receive, Scope, Send


class BearerAuthMiddleware:
    """Rejects HTTP requests without `Authorization: Bearer <token>`. `/healthz` is exempt."""

    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self.expected = f"Bearer {token}".encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] == "/healthz":
            await self.app(scope, receive, send)
            return
        header = dict(scope["headers"]).get(b"authorization", b"")
        if not hmac.compare_digest(header, self.expected):
            await send(
                {
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"www-authenticate", b"Bearer"),
                    ],
                }
            )
            await send(
                {
                    "type": "http.response.body",
                    "body": b'{"error":{"code":"unauthorized","message":"missing or invalid bearer token"}}',
                }
            )
            return
        await self.app(scope, receive, send)
