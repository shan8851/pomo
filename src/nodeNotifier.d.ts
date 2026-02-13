declare module 'node-notifier' {
  interface NotificationPayload {
    title: string;
    message: string;
    wait?: boolean;
    sound?: boolean;
  }

  interface NodeNotifier {
    notify: (payload: NotificationPayload, callback?: () => void) => void;
  }

  const notifier: NodeNotifier;
  export default notifier;
}
