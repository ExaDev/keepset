/* Mantine and Leaflet ship their compiled stylesheets outside their packages' type roots, so each side-effect import needs an ambient declaration to typecheck. */
declare module "@mantine/core/styles.css";
declare module "leaflet/dist/leaflet.css";
