export class Rooms {
  counts(_slug: string): { viewers: number; presenters: number } {
    return { viewers: 0, presenters: 0 };
  }

  removed(_slug: string): void {}
}
