import { health } from "../shared/http.js";

export const options = {
  scenarios: {
    smoke: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
    },
  },
};

export default function () {
  health(__ENV.BASE_URL);
}
