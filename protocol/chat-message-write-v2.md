# Chat HTTP message writes

`POST /api/chat/v2/conversations/{id}/messages` is the current HTTP write
contract. It requires the authenticated session and a JSON body containing
`client_message_id`, `body`, and `content_type: "text"`. Omitted or other
content types are rejected. This version is independent of the WebSocket
protocol version.

Only the versioned write route is registered; the unversioned POST route is not
supported. The version in this HTTP path is independent of the WebSocket
protocol version. `GET /api/chat/conversations/{id}/messages` remains the
history endpoint, and the API may continue to read supported historical content
types from persisted messages.
