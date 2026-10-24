/** Lets version cards show a user name without importing the Panel user store (keeps cards unit-testable). */
import { createContext, type ReactNode } from 'react';

export type RenderUser = (userId: string) => ReactNode;

/** Default: show the raw id. */
export const UserRenderContext = createContext<RenderUser>((userId) => userId);
