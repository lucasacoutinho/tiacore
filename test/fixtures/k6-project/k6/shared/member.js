import http from 'k6/http'

export function member(baseUrl) {
  return http.get(`${baseUrl}/v1/me`)
}
