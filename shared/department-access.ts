/** Who may see which departments on a self-hosted server. `null` means the whole team. */
export interface DepartmentAccessView {
  /** False where people are managed elsewhere (a Team Cloud or a hosted workspace). */
  available: boolean;
  /** Sign-in entry (an address or `@domain`) to the names of the departments that person sees; "" is General. */
  people: Record<string, string[]>;
  /** The saved choices could not be read: until they are fixed, every member sees nothing. */
  unreadable: boolean;
}

export interface DepartmentAccessChange {
  entry: string;
  departments: string[] | null;
}
