import { stopStack } from './stack.ts'

export default async function teardown(): Promise<void> { stopStack() }
