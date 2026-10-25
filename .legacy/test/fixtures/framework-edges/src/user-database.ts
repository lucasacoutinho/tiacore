import { DatabaseSync } from 'node:sqlite'

export function userName(): string {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
  database.exec("INSERT INTO users (name) VALUES ('Lucas')")
  const row = database.prepare('SELECT name FROM users').get() as {
    name: string
  }
  database.close()
  return row.name
}
