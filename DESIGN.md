# Desktop local pages

Local pages extend the bundled new-api interface. Existing runtime tokens and shared components in `vendor/new-api-web/src/components/ui` and the upstream theme styles own color, typography, spacing and control states. Use background, foreground, muted-foreground, primary and destructive semantic utilities; do not introduce a second theme.

Shop uses the same Button component as About and Server settings. Its public `/pa-shop` route reserves the top 144 CSS pixels for navigation, the current domain and actions. The main process owns the matching WebContentsView bounds in content coordinates. The remote document owns its own styling. Keep the toolbar height and main bounds aligned when changing this layout.

Actions disable while pending; errors remain inline with an alert role. Clearing shop data requires an inline confirmation with Cancel first. External links and payment application schemes require a native main-process confirmation. Shop content receives no app API. Route teardown hides the native view; closing the main window closes it.
