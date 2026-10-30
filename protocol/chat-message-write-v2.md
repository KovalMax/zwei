# Chat HTTP message writes v2

`POST /api/chat/v2/conversations/{id}/messages` is the current HTTP write
contract. It requires the authenticated session and a JSON body containing
`client_message_id`, `body`, and `content_type: "text"`. Omitted or other
content types are rejected. This version is independent of the WebSocket
protocol version.

The former `POST /api/chat/conversations/{id}/messages` always returns HTTP
426 with `{"error":"client update required"}` and does not write a message.
Clients must update their endpoint and request format; there is no fallback to
the old write behavior. This is an intentional breaking cutover, so deploy
compatible clients and server together. `GET /api/chat/conversations/{id}/messages`
remains the history endpoint and historical content types remain readable.
