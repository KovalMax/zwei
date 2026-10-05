# KYC pinned table surfaces acceptance

| State | Theme | Viewport | Acceptance |
| --- | --- | --- | --- |
| Accounts table, top and scroll end | Dark | 2560×1440, 1440×900, 1024×900, 390×844 | Bounded table and page; horizontal overflow remains inside table; pinned identity/actions and sticky headings stay in the table bounds. |
| Resend activation feedback, horizontal scroll end | Dark | 390×844 | Feedback remains in-flow above the table; resend/block controls remain visible and actionable; sticky header and pinned first/last cells have computed alpha 1 and remain contained. |
| Resend activation feedback, horizontal scroll end | Light | 390×844 | Same feedback, control, opacity, and containment requirements; screenshots capture the rendered mobile state. |
| Admin table | Dark and light | 1440×900 | Desktop resend captures retained; theme-specific table surface colors remain unchanged. |

The Playwright run saves screenshots for the dark and light mobile resend states in the focused KYC test's output directory. The opaque surfaces use the existing white light-mode surface and dark admin-card surface, without changing the bounded horizontal-scroll interaction.
