class ToolFailure(Exception):
    """An expected failure, returned to the agent as {code, message} instead of a traceback."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
