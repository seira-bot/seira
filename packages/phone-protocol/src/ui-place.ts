/** A place of the app, drawn in chat as a card the person clicks to go there (app_settings show_place). `id` is a place id of
 * the UI map; `text` is the map's own English for a client that does not know this field and shows it as plain text. */
export interface UiPlaceField {
  uiPlace?: { id: string };
}
