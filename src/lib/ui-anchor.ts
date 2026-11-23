import type { UiPlaceId } from "../../shared/ui-places";

/** The `data-ui` value of a mapped control. The type and shared/ui-places.test.ts check the id against the UI map. */
export const ui = (id: UiPlaceId): UiPlaceId => id;
