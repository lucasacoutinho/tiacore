import { health } from '../shared/http.js'
import { member } from '../shared/member.js'

export const options = {
  scenarios: {
    baseline: {
      executor: 'constant-vus',
      vus: 2,
      duration: '5s',
    },
  },
}

export default function () {
  health(__ENV.BASE_URL)
  member(__ENV.BASE_URL)
}
