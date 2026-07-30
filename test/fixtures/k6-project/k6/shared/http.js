import http from "k6/http";

export function health(baseUrl) {
  return http.get(`${baseUrl}/health`);
}
