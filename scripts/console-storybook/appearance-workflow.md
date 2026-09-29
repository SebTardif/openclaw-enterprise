# Console appearance walkthrough

Build Storybook from the changed source and open **Pages/Settings → Dark appearance**.
This uses the production Settings control with simulated account/API responses.

1. Check the dark page, sidebar, text, select, and focus outline. Change **Color theme**
   to **Light**, then **System**; in System, change the browser/device color scheme.
2. Select **Dark**, navigate to Agents and back, and reload. The selection remains.
3. Open another preview tab on the same origin. Change its theme and verify that
   the first tab updates without losing its current form or focus.
4. With Dark selected, inspect existing sign-in, Agent creation, plugin dialog,
   loading, empty, and permission-denied stories. Check readable controls and status
   colors at desktop and mobile sizes. Preferences are shared across previews;
   return to System after the walkthrough.
5. Capture screenshots and a short selection/navigation video outside the checkout.

Record the revision and browser. These fixtures verify presentation only; the
console browser suite exercises preference changes through the real controller.
Neither establishes deployed behavior. If browser storage is blocked, Settings
must report that the change lasts only for the tab, until reload.
