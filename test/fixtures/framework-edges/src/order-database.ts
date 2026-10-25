import { DatabaseSync } from 'node:sqlite'

export function orderTotal(): number {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER)')
  database.exec('INSERT INTO orders (total) VALUES (42)')
  const row = database.prepare('SELECT total FROM orders').get() as {
    total: number
  }
  database.close()
  return row.total
}
