# Registration theme and responsive acceptance

This is the durable visual acceptance matrix for the registration form. The browser test is
`registration fields preserve readable empty, filled, failure, and keyboard-focus states` in
`e2e/tests/auth-flow.spec.ts`.

## Criteria

| State | Acceptance criteria |
| --- | --- |
| Empty | All six visible field labels (email, first name, last name, nickname, password, confirm password) are present as the prompt; each input has no `placeholder` attribute; composited label-to-rendered-field contrast is at least **4.5:1** for every field. |
| Filled | All six inputs contain the entered values; composited value-to-rendered-field contrast is at least **4.5:1** for every input. |
| Validation failure | The mismatched-password validation message is visible; every visible validation message is measured against its composited rendered background and has at least **4.5:1** contrast. The theme's intended error color is checked as well. |
| Keyboard focus and containment | First-name input receives keyboard focus and exposes the Material focused state; the focused input remains within viewport horizontal bounds. |
| Reduced motion | On a 390x844 mobile viewport, Tab advances from email to first name, fields stack in reading order, and the reduced-motion duration is `0ms`. |

The contrast requirement applies independently to **both light and dark themes** and each of
these viewport sizes: **2560x1440, 1440x900, 1024x768, and 390x844**. Colors are alpha-composited
through the field/card/page surfaces before calculating WCAG relative luminance contrast; a
nominal token value or an unasserted diagnostic is not acceptance.

| Theme | 2560x1440 | 1440x900 | 1024x768 | 390x844 |
| --- | --- | --- | --- | --- |
| Light | Empty labels + no placeholders; all filled values; all visible failure messages; focus | Empty labels + no placeholders; all filled values; all visible failure messages; focus | Empty labels + no placeholders; all filled values; all visible failure messages; focus | Empty labels + no placeholders; all filled values; all visible failure messages; focus |
| Dark | Empty labels + no placeholders; all filled values; all visible failure messages; focus | Empty labels + no placeholders; all filled values; all visible failure messages; focus | Empty labels + no placeholders; all filled values; all visible failure messages; focus | Empty labels + no placeholders; all filled values; all visible failure messages; focus |

Every label, entered value, and visible validation message in each matrix cell must meet the
4.5:1 criterion above. The separate reduced-motion keyboard criterion is checked at 390x844.

Placeholders are intentionally not used: visible, programmatically associated labels are the
field prompts. Adding a placeholder must not silently replace or duplicate that prompt; the
browser matrix asserts the placeholder attribute is absent on all six registration inputs.

## Screenshots

For every theme/viewport combination, the passing Playwright run saves these screenshots in
`e2e/test-results/` (test output directory):

- `registration-{light|dark}-{2560|1440|1024|390}-empty.png`
- `registration-{light|dark}-{2560|1440|1024|390}-filled.png`
- `registration-{light|dark}-{2560|1440|1024|390}-failure.png`
- `registration-{light|dark}-{2560|1440|1024|390}-focus.png`

Review representative dark 390px empty, filled, and failure screenshots and a light-theme
registration screenshot after browser runs. These screenshots are generated artifacts and are
not committed. Retain them under the test-results artifact directory for inspection.
