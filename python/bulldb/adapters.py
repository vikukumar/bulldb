from contextlib import asynccontextmanager
from typing import Callable, Any

class FastAPILifespan:
    def __init__(self, db_client: Any):
        self.db_client = db_client

    @asynccontextmanager
    async def lifespan(self, app: Any):
        # 1. Connect all pools on startup
        await self.db_client.connect_all()
        # Register db in BaseModel
        from .models import BaseModel
        BaseModel.set_db(self.db_client)
        
        yield # Application executes
        
        # 2. Cleanup pools on shutdown
        await self.db_client.disconnect_all()


class FlaskMiddleware:
    def __init__(self, app: Any, db_client: Any):
        self.app = app
        self.db_client = db_client
        self.setup_lifecycle()

    def setup_lifecycle(self):
        # Flask requests setup/teardowns hook
        from .models import BaseModel
        BaseModel.set_db(self.db_client)

        @self.app.before_request
        def before_request_hook():
            pass

        @self.app.teardown_request
        def teardown_request_hook(exception=None):
            pass


class SanicMiddleware:
    @staticmethod
    def register(app: Any, db_client: Any):
        from .models import BaseModel

        @app.listener("before_server_start")
        async def setup_db(app_instance, loop):
            await db_client.connect_all()
            BaseModel.set_db(db_client)

        @app.listener("after_server_stop")
        async def close_db(app_instance, loop):
            await db_client.disconnect_all()


class DjangoMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from .models import BaseModel
        from .database import db
        BaseModel.set_db(db)
        
        response = self.get_response(request)
        return response


class DjangoLifecycle:
    @staticmethod
    def register(db_client: Any = None):
        try:
            from django.core.signals import request_started, request_finished
            from .models import BaseModel
            from .database import db
            
            target_db = db_client or db

            def on_request_started(sender, **kwargs):
                BaseModel.set_db(target_db)

            def on_request_finished(sender, **kwargs):
                pass

            request_started.connect(on_request_started)
            request_finished.connect(on_request_finished)
        except Exception:
            pass
